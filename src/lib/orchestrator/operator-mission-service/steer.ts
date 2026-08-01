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
import { recordLaneEvent } from '@/lib/lane/events';
import { rebindLaneSessionIfChanged } from '@/lib/lane/session-rebind';
import { findMissionRegistryEntryByPacketId } from '@/lib/orchestrator/mission-registry';
import { performRuntimeAction } from '@/lib/runtime/actions';
import { currentMissionState } from './shared';
import { continueOwnedCodexSession, getOwnedCodexRuntimeTail, getOwnedCodexTelemetrySources } from '@/lib/codex/owned';

export interface SteerPacketInput {
  packetId: string;
  message: string;
  source?: string;
}

export interface SteerPacketResult {
  packetId: string;
  laneId: string;
  note: string;
}

const NO_STEERABLE_SESSION = 'Packet has no steerable session — use rerun_with_feedback instead.';
const STARTUP_FAILURE_PROBE_MS = 2_000;

export class SteerPacketUnavailableError extends Error {
  readonly code = 'steer_unavailable';
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

export async function steerPacket({ packetId, message, source }: SteerPacketInput): Promise<SteerPacketResult> {
  const lane = findLaneByPacket(packetId);
  if (!lane?.sessionKey) {
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
  recordLaneEvent(lane.id, 'steered_packet', 'orchestrator', {
    packetId,
    source: steerSource,
    message,
  });

  const result = await performRuntimeAction({ action: 'steer', surfaceId: lane.sessionKey, message, auditSteer: false });
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
        note: resumed?.note || result.note || NO_STEERABLE_SESSION,
      });
      throw new SteerPacketUnavailableError(resumed?.note || result.note || NO_STEERABLE_SESSION);
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
      note: 'Steer failed to start',
      stderrHead: startupFailure,
    });
    throw new Error(`Steer failed to start: ${startupFailure}`);
  }

  const updated = setLaneStatus(lane.id, 'running', 'orchestrator', 'steered_packet');
  if (!updated || updated.status !== 'running') {
    throw new SteerPacketUnavailableError(NO_STEERABLE_SESSION);
  }

  return { packetId, laneId: lane.id, note: steeredNote };
}
