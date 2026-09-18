/**
 * Push notification gate (#2441, program #2481). RECORD-ONLY.
 *
 * Every push goes out exactly as before. Alongside it, and only when
 * `judgment.provider` is on, one detached call asks the locked push gate
 * question over o8-computed facts: event kind, lane state, packet outcome,
 * gate result, the approval's stored referee answers (#2435), the object's
 * age, whether the event is operator-gated, quiet mode, and the local hour.
 * No title, message body, session name, or repo name reaches the state.
 *
 * The answer is written to a `push_gate` lane event with the would-suppress
 * decision at the PROVISIONAL band (not operator-gated and p at or below
 * ABSTAIN_CONFIDENCE). Nothing reads it. An event with no lane (merge
 * conflict, orchestrator ready) keeps its receipt only. The replay label
 * `pushGate` scores the recorded answers against what the operator did next.
 */
import { getSqlite } from '@/lib/db';
import { askJudgment, type AskJudgmentOptions } from '@/lib/judgment/client';
import { PUSH_GATE_QUESTION } from '@/lib/judgment/questions';
import { isJudgmentRefereeEnabled } from '@/lib/judgment/route';
import { ABSTAIN_CONFIDENCE } from '@/lib/judgment/types';

export const PUSH_GATE_SURFACE = 'push-gate';

export type PushGateKind = 'approval_created' | 'agent_finished' | 'merge_conflict' | 'orchestrator_ready' | 'review_ready';

/** Ids and o8 facts the mapper already holds. Nothing here is sent as-is except `terminalState`. */
export interface PushGateEvent {
  kind: PushGateKind;
  approvalId?: string;
  laneId?: string | null;
  packetId?: string | null;
  /** Lifecycle state for agent_finished (completed / failed / killed / stalled). */
  terminalState?: string;
  /** Session key an agent_finished event names; used only to find its lane. */
  sessionKey?: string;
}

export interface PushGateState {
  kind: PushGateKind;
  laneState: string | null;
  packetOutcome: string | null;
  gate: { passed: boolean } | null;
  referee: { docsOnly: number; risk: number } | null;
  ageMs: number | null;
  operatorGated: boolean;
  quietMode: boolean;
  hourOfDay: number;
}

/** Payload of the `push_gate` lane event. */
export interface PushGateRecord {
  receiptId: string | null;
  kind: PushGateKind;
  p: number;
  wouldSuppress: boolean;
  operatorGated: boolean;
}

/** One bounded attempt: the push never waits on this, and a stuck call must not pile up. */
const PRODUCTION_TRANSPORT: AskJudgmentOptions = { timeoutMs: 8_000, maxAttempts: 1 };

let transportOverride: AskJudgmentOptions | undefined;
const inFlight = new Set<Promise<PushGateRecord | null>>();

/** Test-only: point the gate at a local endpoint fixture. */
export function setPushGateTransportForTests(options: AskJudgmentOptions | undefined): void {
  transportOverride = options;
}

/** Resolves when every gate call started so far has settled. */
export async function waitForPushGates(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

async function buildState(event: PushGateEvent, now: number): Promise<{ state: PushGateState; laneId: string | null; packetId: string | null }> {
  const { getLane, findLaneBySession } = await import('@/lib/lane/registry');
  let laneId = event.laneId ?? null;
  let packetId = event.packetId ?? null;
  let gate: PushGateState['gate'] = null;
  let referee: PushGateState['referee'] = null;
  let createdAt: number | null = null;

  if (event.approvalId) {
    const { getApproval } = await import('@/lib/approvals/store');
    const { extractApprovalContextIds } = await import('@/lib/approvals/context');
    const approval = getApproval(event.approvalId);
    if (approval) {
      const ids = extractApprovalContextIds(approval.metadata);
      laneId ??= approval.continuation?.kind === 'lane' ? approval.continuation.laneId : ids.laneId;
      packetId ??= ids.packetId;
      gate = approval.gateResult ? { passed: approval.gateResult.passed } : null;
      referee = approval.referee
        ? { docsOnly: approval.referee.answers.docsOnly.noul, risk: approval.referee.answers.risk.score }
        : null;
      createdAt = approval.createdAt;
    }
  }

  const lane = laneId ? getLane(laneId) : event.sessionKey ? findLaneBySession(event.sessionKey) : null;
  if (lane) {
    laneId = lane.id;
    packetId ??= lane.packetId;
    createdAt ??= Date.parse(lane.createdAt);
  }

  let packetOutcome = event.terminalState ?? null;
  if (!packetOutcome && packetId) {
    const row = getSqlite()
      .prepare('SELECT outcome FROM session_outcomes WHERE packet_id = ? ORDER BY completed_at DESC LIMIT 1')
      .get(packetId) as { outcome: string } | undefined;
    packetOutcome = row?.outcome ?? null;
  }

  const { getOperatorDefaultsSync } = await import('@/lib/operator/defaults');
  return {
    laneId,
    packetId,
    state: {
      kind: event.kind,
      laneState: lane?.status ?? null,
      packetOutcome,
      gate,
      referee,
      ageMs: createdAt !== null && Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : null,
      // Approval cards always push once suppression exists.
      operatorGated: event.kind === 'approval_created',
      quietMode: getOperatorDefaultsSync().values.presentationQuietMode === true,
      hourOfDay: new Date(now).getHours(),
    },
  };
}

async function run(event: PushGateEvent): Promise<PushGateRecord | null> {
  try {
    const { state, laneId, packetId } = await buildState(event, Date.now());
    const result = await askJudgment({
      state,
      questions: { attentionNow: PUSH_GATE_QUESTION },
      context: { surface: PUSH_GATE_SURFACE, laneId, packetId, approvalId: event.approvalId ?? null },
    }, transportOverride ?? PRODUCTION_TRANSPORT);
    if (!result) return null;
    const p = result.answers.attentionNow.noul;
    const record: PushGateRecord = {
      receiptId: result.receiptId,
      kind: event.kind,
      p,
      // PROVISIONAL band; nothing acts on it.
      wouldSuppress: !state.operatorGated && p <= ABSTAIN_CONFIDENCE,
      operatorGated: state.operatorGated,
    };
    if (laneId) {
      const { recordLaneEvent } = await import('@/lib/lane/events');
      recordLaneEvent(laneId, 'push_gate', 'system', { ...record });
    } else {
      console.log(`[push-gate] ${event.kind} has no lane; receipt ${record.receiptId ?? 'none'} only`);
    }
    return record;
  } catch (error) {
    console.warn('[push-gate] skipped:', error instanceof Error ? error.message : 'error');
    return null;
  }
}

/** Ask the gate question for an outgoing push. Detached; never throws; no-op with the setting off. */
export function recordPushGate(event: PushGateEvent): void {
  if (!isJudgmentRefereeEnabled()) return;
  const pending = run(event);
  inFlight.add(pending);
  void pending.finally(() => inFlight.delete(pending));
}
