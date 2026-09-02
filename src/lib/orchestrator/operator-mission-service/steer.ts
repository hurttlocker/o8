/**
 * steerPacket — nudge a packet's warm session with a follow-up message.
 *
 * CLI-as-control-plane symmetry (Stage 4). This was the one
 * mission verb with no HTTP route: the MCP `steer_packet` handler resolved the
 * lane and flipped its status IN ITS OWN PROCESS (a separate in-memory registry
 * instance from the app), only the runtime steer itself crossing the HTTP seam.
 * Extracting it here — and routing both the MCP tool and the `o8 packet steer`
 * CLI through `/api/orchestrator/steer-packet` — means the lane resolution +
 * status flip run in the Next process where the live registry and warm-session
 * pool actually live. Removes the cross-process-registry fragility.
 *
 * Layer 3 of the merge-failure escalation chain (CLAUDE.md): cheaper than a
 * fresh redispatch because it reuses the warm Codex thread.
 */

import { findLaneByPacket, setLaneStatus } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { recordLaneEvent } from '@/lib/lane/events';
import { rebindLaneSessionIfChanged } from '@/lib/lane/session-rebind';
import {
  findMissionRegistryEntryByPacketId,
  withMissionRegistryState,
} from '@/lib/orchestrator/mission-registry';
import { resolvePacketAlignment } from '@/lib/orchestrator/alignment-access';
import { withLockedState } from '@/lib/orchestrator/control-plane';
import { withMissionHandoffBarrier } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { performRuntimeAction } from '@/lib/runtime/actions';
import { currentMissionState } from './shared';
import { continueOwnedCodexSession, getOwnedCodexRuntimeTail, getOwnedCodexTelemetrySources } from '@/lib/codex/owned';

export interface SteerPacketInput {
  packetId: string;
  message: string;
  source?: string;
  clientMutationId?: string;
}

export interface SteerPacketResult {
  packetId: string;
  laneId: string;
  note: string;
}

export const NO_STEERABLE_SESSION = 'Packet has no steerable session — use rerun_with_feedback instead.';
const STARTUP_FAILURE_PROBE_MS = 2_000;

export type SteerPacketFailurePhase = 'pre_effect' | 'terminal' | 'outcome_unknown';

export class SteerPacketUnavailableError extends Error {
  constructor(message: string, readonly phase: SteerPacketFailurePhase = 'pre_effect') {
    super(message);
    this.name = 'SteerPacketUnavailableError';
  }

  get code(): 'steer_unavailable' | 'steer_outcome_unknown' {
    return this.phase === 'outcome_unknown' ? 'steer_outcome_unknown' : 'steer_unavailable';
  }
}

export function isPostEffectSteerFailure(error: unknown): error is SteerPacketUnavailableError {
  return error instanceof SteerPacketUnavailableError && error.phase !== 'pre_effect';
}

export function findSteerablePacketLane(packetId: string): (Lane & { sessionKey: string }) | null {
  const lane = findLaneByPacket(packetId);
  return lane?.sessionKey ? lane as Lane & { sessionKey: string } : null;
}

export function isNoSteerableSessionError(error: unknown): boolean {
  return error instanceof SteerPacketUnavailableError && error.message === NO_STEERABLE_SESSION;
}

function outcomeUnknownSteerError(error: unknown): SteerPacketUnavailableError {
  const detail = error instanceof Error ? error.message : String(error);
  return new SteerPacketUnavailableError(
    `${detail} The steer may already have been accepted; inspect the session before sending it again.`,
    'outcome_unknown',
  );
}

function normalizeSource(source: string | undefined): string {
  const normalized = source?.trim().toLowerCase();
  if (normalized === 'operator' || normalized === 'heal-bot' || normalized === 'orchestrator') {
    return normalized;
  }
  return 'orchestrator';
}

function stderrPathForStdout(stdoutPath: string): string {
  return stdoutPath.endsWith('.jsonl')
    ? stdoutPath.replace(/\.jsonl$/, '.stderr.log')
    : `${stdoutPath}.stderr.log`;
}

async function readStartupFailureHead(surfaceId: string, sinceMs: number): Promise<string | null> {
  if (!surfaceId.startsWith('codex-owned:')) return null;
  await new Promise((resolve) => setTimeout(resolve, STARTUP_FAILURE_PROBE_MS));
  const sources = await getOwnedCodexTelemetrySources(surfaceId);
  const stdoutPath = sources?.stdoutPaths[sources.stdoutPaths.length - 1];
  if (!stdoutPath) return null;
  const { readFile } = await import('node:fs/promises');
  const stderr = await readFile(stderrPathForStdout(stdoutPath), 'utf8').catch(() => '');
  const tail = await getOwnedCodexRuntimeTail(surfaceId).catch(() => null);
  const lifecycle = tail?.surface.lifecycle;
  // Only a run STARTED BY THIS STEER counts — a previous resume's failure must
  // not flag a fresh, healthy steer (caught by the #1415 regression test).
  const lastRunStartedMs = lifecycle?.lastRunStartedAt ? Date.parse(lifecycle.lastRunStartedAt) : NaN;
  const startedByThisSteer = Number.isFinite(lastRunStartedMs) && lastRunStartedMs >= sinceMs - 1_000;
  if (startedByThisSteer && lifecycle?.lastRunMode === 'resume' && lifecycle.lastOutcome === 'failed') {
    return (stderr.trim() || lifecycle.summary || 'owned Codex resume exited non-zero')
      .replace(/\s+/g, ' ')
      .slice(0, 500);
  }
  return null;
}

async function resumeExitedOwnedCodexSession(surfaceId: string, message: string) {
  if (!surfaceId.startsWith('codex-owned:')) {
    return null;
  }

  // #1524 — no telemetry pre-gate: it returned null for archived sessions,
  // silently killing the fallback in exactly the death scenarios steer exists
  // to recover from. The store's resume now handles every case itself (cold
  // restore from archive included) and throws a specific reason when it truly
  // cannot — surface that reason instead of the generic steer failure.
  try {
    return await continueOwnedCodexSession(surfaceId, message);
  } catch (error) {
    return { ok: false, note: error instanceof Error ? error.message : String(error) };
  }
}

async function markAlignmentResolved(packetId: string): Promise<void> {
  await withMissionHandoffBarrier(async () => {
    let currentMissionId = '';
    const { result: foundCurrent } = await withLockedState((current) => {
      currentMissionId = current.missionId?.trim() ?? '';
      const packet = current.packets.find((candidate) => candidate.id === packetId);
      if (!packet) return false;
      if (resolvePacketAlignment(packet).armed) {
        packet.alignmentResolvedAt = new Date().toISOString();
      }
      return true;
    });
    if (foundCurrent) return;

    const entry = findMissionRegistryEntryByPacketId(packetId, {
      includeArchived: true,
      excludeMissionId: currentMissionId || undefined,
    });
    if (!entry) return;
    await withMissionRegistryState(entry.id, (state) => {
      const packet = state.packets.find((candidate) => candidate.id === packetId);
      if (packet && resolvePacketAlignment(packet).armed) {
        packet.alignmentResolvedAt = new Date().toISOString();
      }
      return { state, result: undefined };
    });
  });
}

export async function steerPacket({
  packetId,
  message,
  source,
  clientMutationId,
}: SteerPacketInput): Promise<SteerPacketResult> {
  const lane = findSteerablePacketLane(packetId);
  if (!lane) {
    const current = currentMissionState();
    const packetExists = current.packets.some((packet) => packet.id === packetId)
      || Boolean(findMissionRegistryEntryByPacketId(packetId, {
        includeArchived: true,
        excludeMissionId: current.missionId,
      }));
    if (!packetExists) {
      throw new Error(`Packet ${packetId} not found.`);
    }
    throw new SteerPacketUnavailableError(NO_STEERABLE_SESSION);
  }

  const steerSource = normalizeSource(source);
  const steerStartedMs = Date.now();
  // From the first durable event onward, a thrown call can no longer prove
  // that no visible or provider-side effect landed. All failures below this
  // boundary are typed so routes can finalize a receipt before responding.
  try {
    recordLaneEvent(lane.id, 'steered_packet', 'orchestrator', {
      packetId,
      source: steerSource,
      message,
      clientMutationId,
    });

    const result = await performRuntimeAction({
      action: 'steer',
      surfaceId: lane.sessionKey,
      clientMutationId,
      message,
      auditSteer: false,
    });
    let steeredNote = 'Steered packet via warm session.';
    if (!result.ok || result.status === 'unavailable') {
      const canTryOwnedResumeFallback = lane.sessionKey.startsWith('codex-owned:')
        && /cannot accept|not found|surface/i.test(result.note);
      // Adversarial F14 — re-check the lane right before spawning the fallback
      // process: the operator may have archived it during the (multi-second)
      // steer attempt, and only the lane STATUS write was protected — not the
      // process spawn. A lane that went terminal mid-steer must not get a
      // fresh runtime editing its worktree.
      const freshLane = canTryOwnedResumeFallback ? findLaneByPacket(packetId) : null;
      const laneStillLive = freshLane?.id === lane.id && freshLane.sessionKey === lane.sessionKey;
      const resumed = canTryOwnedResumeFallback && laneStillLive
        ? await resumeExitedOwnedCodexSession(lane.sessionKey, message)
        : canTryOwnedResumeFallback
          ? { ok: false, note: 'Lane went terminal while the steer was in flight — not resuming a dead lane\'s session.' }
          : null;
      if (!resumed?.ok) {
        recordLaneEvent(lane.id, 'steer_failed', 'orchestrator', {
          packetId,
          source: steerSource,
          message,
          clientMutationId,
          note: resumed?.note || result.note || NO_STEERABLE_SESSION,
        });
        throw new SteerPacketUnavailableError(
          resumed?.note || result.note || NO_STEERABLE_SESSION,
          'terminal',
        );
      }
      // #1524 — the store's note distinguishes warm resume from cold
      // (restored-from-archive) resume; pass it through so cost expectations
      // stay honest for the orchestrator that chose layer 3 over layer 4.
      steeredNote = resumed.note || 'Steered packet via session resume.';
    } else {
      rebindLaneSessionIfChanged(lane.id, lane.sessionKey, result.sessionKey, 'orchestrator');
    }

    const startupFailure = await readStartupFailureHead(lane.sessionKey, steerStartedMs);
    if (startupFailure) {
      recordLaneEvent(lane.id, 'steer_failed', 'orchestrator', {
        packetId,
        source: steerSource,
        message,
        clientMutationId,
        note: 'Steer failed to start',
        stderrHead: startupFailure,
      });
      throw new SteerPacketUnavailableError(`Steer failed to start: ${startupFailure}`, 'terminal');
    }

    // Huddle/advisor alignment is a one-time turn. Only consume it after the
    // warm resume (or cold owned-session fallback) has actually started; an
    // unavailable steer must leave the alignment prompt armed for recovery.
    await markAlignmentResolved(packetId);

    const updated = setLaneStatus(lane.id, 'running', 'orchestrator', 'steered_packet');
    if (!updated || updated.status !== 'running') {
      throw new SteerPacketUnavailableError(NO_STEERABLE_SESSION, 'terminal');
    }

    return { packetId, laneId: lane.id, note: steeredNote };
  } catch (error) {
    if (error instanceof SteerPacketUnavailableError) throw error;
    throw outcomeUnknownSteerError(error);
  }
}
