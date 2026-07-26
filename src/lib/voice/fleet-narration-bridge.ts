import 'server-only';

/**
 * Fleet narration bridge (#1616 — voice slice) — the live wiring that turns the
 * dormant narration CORE into an importable path.
 *
 * Before this module, `fleet-narration-events.ts` (normalize) and
 * `narration-policy.ts` (decide) were pure, tested functions with ZERO live
 * callers — the "what to speak / when / budget-aware" brain existed but nothing
 * fed it real fleet transitions. This bridge taps the live lane-lifecycle ring
 * buffer (`recordLaneEvent` / `getLaneEventsSince` in
 * `src/lib/orchestrator/runtime-status.ts` — the same bus the
 * `/api/orchestrator/lane-events` long-poll reads) and runs each transition
 * through normalize → decide, producing real `NarrationDecision`s.
 *
 * Reasoning split (operator lock): this module only decides WHAT to say via the
 * policy engine — the realtime model just voices the resulting utterances. No
 * governance decision is made here; blocking transitions are flagged
 * `interrupt-now`, FYIs `hold`, low-value chatter `suppress`.
 *
 * Everything is behind {@link voiceNarrationEnabled} (env `O8_VOICE_NARRATION`,
 * default OFF) so it stays dormant and cannot destabilize the launch build.
 */

import type { LaneStatus } from '@/lib/lane/types';
import type { LaneEvent } from '@/lib/lane/types';
import type { AgentStatus } from '@/lib/fleet/types';
import {
  getLaneEventsSince,
  type LaneLifecycleEventRecord,
} from '@/lib/orchestrator/runtime-status';
import {
  normalizeFleetNarrationEvents,
  type FleetNarrationSourceEvent,
} from './fleet-narration-events';
import {
  decideFleetNarration,
  rankByValuePerVoiceSecond,
  type NarrationDecision,
  type NarrationMemory,
  type NarrationFleetAgentState,
  type NarrationPolicyResult,
} from './narration-policy';
import type { VoiceBudgetState } from './voice-budget';

/** The ChatGPT "Connected Voice time" pool — 5-hour rolling window (the free
 *  OAuth realtime path rides this sub pool, not metered API spend). Used as the
 *  default budget until real per-utterance spend accounting is wired. */
export const VOICE_POOL_LIMIT_SECONDS = 5 * 60 * 60;
export const VOICE_POOL_WINDOW_MS = 5 * 60 * 60 * 1000;

/**
 * Capability flag — voice narration stays dormant unless `O8_VOICE_NARRATION`
 * is explicitly truthy (`1`/`true`/`on`). Default OFF so the launch build is
 * unaffected. Kept as a tiny env gate (mirrors `MANAGED_REALTIME_READY`) rather
 * than threading a new field through the 40+-knob operator-defaults machine —
 * this is server infra, not yet a user-facing setting.
 */
export function voiceNarrationEnabled(): boolean {
  const raw = process.env.O8_VOICE_NARRATION?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** A fresh voice budget with the full 5-hour pool available (no spend yet). */
export function freshVoiceBudget(nowMs: number = Date.now()): VoiceBudgetState {
  return {
    limitSeconds: VOICE_POOL_LIMIT_SECONDS,
    windowMs: VOICE_POOL_WINDOW_MS,
    nowMs,
    spends: [],
  };
}

/** Coarse LaneStatus → AgentStatus map, for the policy's active-agent count
 *  (concurrency ceiling). Only the active/terminal distinction matters here. */
function laneStatusToAgentStatus(status: LaneStatus): AgentStatus {
  switch (status) {
    case 'running':
    case 'merging':
    case 'launching':
      return 'running';
    case 'reviewing':
      return 'reviewing';
    case 'awaiting_input':
    case 'awaiting_orchestrator':
    case 'awaiting_human':
    case 'recovering':
      return 'blocked';
    default:
      return 'idle';
  }
}

/**
 * Map one live lane-lifecycle record into a narration source event. Modeled as
 * a `status_change` lane-event so it routes through the existing
 * `classifyLaneEvent` → `classifyStatus` path; agent identity rides the
 * sessionKey/runtime so the spoken label is human (`agentDisplayLabel`).
 */
export function laneLifecycleToNarrationSource(
  rec: LaneLifecycleEventRecord,
): FleetNarrationSourceEvent {
  const event: LaneEvent = {
    id: `lane-lifecycle-${rec.laneId}-${rec.seq}`,
    laneId: rec.laneId,
    verb: 'status_change',
    actor: 'system',
    payload: {
      status: rec.status,
      to: rec.status,
      previousStatus: rec.previousStatus,
    },
    timestamp: rec.timestamp,
  };
  return {
    source: 'lane-event',
    event,
    agent: {
      id: rec.laneId,
      sessionKey: rec.sessionKey,
      runtime: null,
    },
  };
}

/** Derive the policy's fleet snapshot from a batch of records — distinct lanes
 *  with their latest status, coarsely mapped to AgentStatus. */
function fleetAgentsFromRecords(
  records: readonly LaneLifecycleEventRecord[],
): NarrationFleetAgentState[] {
  const latest = new Map<string, LaneStatus>();
  for (const rec of records) latest.set(rec.laneId, rec.status);
  return [...latest.entries()].map(([id, status]) => ({
    id,
    status: laneStatusToAgentStatus(status),
  }));
}

export interface FleetNarrationCoreInput {
  records: readonly LaneLifecycleEventRecord[];
  budget: VoiceBudgetState;
  memory?: NarrationMemory;
  /** Explicit fleet agents (concurrency ceiling). Defaults to a set derived
   *  from the record batch. */
  fleetAgents?: readonly NarrationFleetAgentState[];
  concurrencyCeiling?: number;
  ambientCadenceDue?: boolean;
  onDemandRequested?: boolean;
}

export interface FleetNarrationCoreResult extends NarrationPolicyResult {
  /** Decisions the policy chose to voice now, ranked by value-per-voice-second. */
  spoken: NarrationDecision[];
}

/**
 * Pure core (no I/O) — records → narration decisions. Exported for tests; the
 * server entry {@link pollFleetNarration} feeds it live records.
 *
 * Non-transitions (previousStatus === status) are dropped before normalization;
 * the policy's own transition-memory dedups repeats across successive polls.
 */
export function decideNarrationForRecords(
  input: FleetNarrationCoreInput,
): FleetNarrationCoreResult {
  const transitions = input.records.filter(
    (rec) => rec.previousStatus !== rec.status,
  );
  const sources = transitions.map(laneLifecycleToNarrationSource);
  const events = normalizeFleetNarrationEvents(sources);
  const result = decideFleetNarration({
    events,
    fleet: {
      agents: input.fleetAgents ?? fleetAgentsFromRecords(transitions),
      ambientCadenceDue: input.ambientCadenceDue,
      onDemandRequested: input.onDemandRequested,
      concurrencyCeiling: input.concurrencyCeiling,
    },
    budget: input.budget,
    memory: input.memory,
  });
  const spoken = rankByValuePerVoiceSecond(
    result.decisions.filter((decision) => decision.action === 'speak'),
  );
  return { ...result, spoken };
}

export interface PollFleetNarrationInput {
  since: number;
  timeoutMs?: number;
  budget?: VoiceBudgetState;
  memory?: NarrationMemory;
  laneFilter?: ReadonlySet<string>;
  ambientCadenceDue?: boolean;
  onDemandRequested?: boolean;
  concurrencyCeiling?: number;
}

export interface PollFleetNarrationResult extends FleetNarrationCoreResult {
  nextSince: number;
  enabled: boolean;
}

/**
 * Server entry — long-poll the live lane-lifecycle bus from `since`, then run
 * the batch through the narration policy. Returns immediately with `enabled:
 * false` and no decisions when the capability flag is off, so callers can poll
 * unconditionally without special-casing the dormant state.
 */
export async function pollFleetNarration(
  input: PollFleetNarrationInput,
): Promise<PollFleetNarrationResult> {
  if (!voiceNarrationEnabled()) {
    return {
      enabled: false,
      decisions: [],
      spoken: [],
      nextMemory: input.memory ?? {},
      activeAgentCount: 0,
      exceptionsOnly: false,
      nextSince: input.since,
    };
  }

  const { events: records, nextSince } = await getLaneEventsSince(
    input.since,
    input.timeoutMs ?? 0,
    input.laneFilter,
  );
  const core = decideNarrationForRecords({
    records,
    budget: input.budget ?? freshVoiceBudget(),
    memory: input.memory,
    ambientCadenceDue: input.ambientCadenceDue,
    onDemandRequested: input.onDemandRequested,
    concurrencyCeiling: input.concurrencyCeiling,
  });
  return { ...core, enabled: true, nextSince };
}
