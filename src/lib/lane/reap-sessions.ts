import type { Lane, LaneEventVerb } from '@/lib/lane/types';
import type { RuntimeId } from '@/lib/runtimes/types';
import { recordLaneEvent } from '@/lib/lane/events';

// #1471 S1 — `kill_escalated` is a new lane-event verb owned by the
// state-machine-truth builder's union. Until it lands in `LaneEventVerb`, cast
// at the single emit site (INTEGRATION: add `| 'kill_escalated'` to the union).
const KILL_ESCALATED = 'kill_escalated' as unknown as LaneEventVerb;

/**
 * Reap live runtime processes for a set of lanes — shared by `stop-packet`
 * (#1286) and `reset_packet` (#1292) so BOTH hard-cancel the underlying process
 * before the lane's sessionKey is nulled. Without this, reset archived the lane
 * but left the `codex exec` churning, and when that orphan exited/failed the
 * agent-supervisor relaunched it into a sibling lane (the zombie-multiply bug).
 *
 * Interrupt (SIGINT via the runtime adapter) is a CLEAN stop, not a `failed`
 * status, so the supervisor does not auto-retry it — confirmed by stop-packet's
 * proven "not relaunched" behavior.
 */

export interface InterruptTarget {
  laneId: string;
  runtime: RuntimeId;
  sessionKey: string;
}

/**
 * Pure: the lanes that have a live session to interrupt, as (laneId, runtime,
 * sessionKey) triples. Lanes with no/blank sessionKey are skipped (nothing to
 * reap). Captured from the lane list BEFORE any mutation nulls sessionKey.
 */
export function interruptableSessions(lanes: Lane[]): InterruptTarget[] {
  const out: InterruptTarget[] = [];
  for (const lane of lanes) {
    const sessionKey = lane.sessionKey?.trim();
    if (!sessionKey) continue;
    out.push({ laneId: lane.id, runtime: lane.runtime as RuntimeId, sessionKey });
  }
  return out;
}

/**
 * Interrupt each lane's live session through the universal runtime router
 * (reaps the process per-runtime). Best-effort: a failed kill is logged, not
 * thrown — the caller's archive still proceeds. Returns the number reaped.
 */
export async function interruptLaneSessions(lanes: Lane[]): Promise<number> {
  const targets = interruptableSessions(lanes);
  if (targets.length === 0) return 0;
  const { routeAction } = await import('@/lib/runtimes/registry');
  let interrupted = 0;
  for (const target of targets) {
    try {
      await routeAction(target.runtime, 'interrupt', target.sessionKey);
      interrupted += 1;
    } catch (error) {
      console.warn(`[reap-sessions] interrupt failed for lane ${target.laneId} (${target.runtime}):`, error);
    }
  }
  return interrupted;
}

/**
 * #1471 S1 — CONFIRMED kill with escalation. The plain `interruptLaneSessions`
 * above fires a single best-effort SIGINT and returns; the caller then flips the
 * lane's status whether or not the process actually died — the lie #1471 filed.
 *
 * This reaps each lane's live session through the SIGINT → SIGTERM → SIGKILL
 * escalation ladder (`runtime/interrupt-escalation.ts`, PID-reuse-guarded) and
 * only reports `confirmed` after the process is verified gone (kill(pid,0) →
 * ESRCH). It emits a `kill_escalated` lane event per stage so the operator can
 * audit exactly what ended the worker (payload {stage, pid, confirmed}) — the
 * stage names the MECHANISM, which on Windows is a single forced tree-kill on
 * every rung rather than three escalating signals.
 * When even the last rung can't be confirmed, `confirmed:false` bubbles up so
 * the caller marks the lane `kill_unconfirmed` instead of pretending it stopped.
 *
 * Owned dispatch workers (`codex-owned:` / `claude-code-owned:`) get the full
 * ladder. Discovered / gemini / opencode sessions fall back to the single-signal
 * interrupt (no live pid to probe) — best-effort, `verified:false` in the event.
 */
export interface ConfirmedKillStage {
  /**
   * What actually ended (or failed to end) the worker, not which rung asked.
   * `taskkill-tree` is the only mechanism Windows has, so all three rungs
   * record it there — the ladder's own signal names would claim a graceful
   * stop for a forced kill. `interrupt` is the unverified single-shot fallback.
   */
  stage: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'taskkill-tree' | 'interrupt';
  confirmed: boolean;
  pid?: number;
}

export interface ConfirmedKillOutcome {
  laneId: string;
  sessionKey: string;
  runtime: RuntimeId;
  confirmed: boolean;
  alreadyDead: boolean;
  pid?: number;
  stages: ConfirmedKillStage[];
  note: string;
}

function hasEscalationLadder(sessionKey: string): boolean {
  return sessionKey.startsWith('codex-owned:') || sessionKey.startsWith('claude-code-owned:');
}

async function killTargetConfirmed(target: InterruptTarget): Promise<ConfirmedKillOutcome> {
  const emit = (stage: ConfirmedKillStage, extra: Record<string, unknown> = {}) => {
    try {
      recordLaneEvent(target.laneId, KILL_ESCALATED, 'system', {
        sessionKey: target.sessionKey,
        stage: stage.stage,
        pid: stage.pid,
        confirmed: stage.confirmed,
        ...extra,
      });
    } catch (error) {
      console.warn(`[kill] failed to record kill_escalated for lane ${target.laneId}:`, error);
    }
  };

  if (hasEscalationLadder(target.sessionKey)) {
    const { escalateInterruptOwnedSurface } = await import('@/lib/runtime/interrupt-escalation');
    const result = await escalateInterruptOwnedSurface(target.sessionKey);
    if (result) {
      const stages: ConfirmedKillStage[] = result.steps.map((step) => ({
        stage: step.mechanism,
        confirmed: !step.aliveAfter,
        pid: result.pid,
      }));
      for (const stage of stages) emit(stage);
      return {
        laneId: target.laneId,
        sessionKey: target.sessionKey,
        runtime: target.runtime,
        confirmed: result.confirmedDead,
        alreadyDead: result.alreadyDead,
        pid: result.pid,
        stages,
        note: result.note,
      };
    }
    // null → surface outside the live inventory; fall through to best-effort.
  }

  // Fallback: single-signal interrupt through the runtime router. No live pid to
  // probe, so `confirmed` reflects the runtime's own ok, flagged unverified.
  try {
    const { routeAction } = await import('@/lib/runtimes/registry');
    const res = await routeAction(target.runtime, 'interrupt', target.sessionKey) as { ok?: boolean; note?: string };
    const confirmed = res?.ok === true;
    const stage: ConfirmedKillStage = { stage: 'interrupt', confirmed };
    emit(stage, { verified: false });
    return {
      laneId: target.laneId,
      sessionKey: target.sessionKey,
      runtime: target.runtime,
      confirmed,
      alreadyDead: false,
      stages: [stage],
      note: res?.note ?? 'Best-effort interrupt (no live pid to confirm).',
    };
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error);
    console.warn(`[kill] interrupt failed for lane ${target.laneId} (${target.runtime}):`, error);
    return {
      laneId: target.laneId,
      sessionKey: target.sessionKey,
      runtime: target.runtime,
      confirmed: false,
      alreadyDead: false,
      stages: [],
      note,
    };
  }
}

/**
 * Confirmed-kill each lane's live session (SIGINT→SIGTERM→SIGKILL + exit probe).
 * Returns one outcome per lane that HAD a session; lanes with no sessionKey are
 * skipped. Never throws — a failed kill is captured as `confirmed:false`.
 */
export async function killLaneSessionsConfirmed(lanes: Lane[]): Promise<ConfirmedKillOutcome[]> {
  const targets = interruptableSessions(lanes);
  const outcomes: ConfirmedKillOutcome[] = [];
  for (const target of targets) {
    outcomes.push(await killTargetConfirmed(target));
  }
  return outcomes;
}

/**
 * #1292 ROOT — archive each lane's owned-session DIRECTORY (move it to the
 * runtime's `-archive` tree) after the process is interrupted. Reset previously
 * archived the LANE + nulled fields but LEFT the `~/.o8/owned-<runtime>/<id>/`
 * dir in the ACTIVE tree, so on the next app launch the owned-session discovery
 * (`computeFleetAdditions` — which has no retirement gate, only a 24h age
 * filter) re-found the orphan and re-created a phantom lane. This was the real
 * multiply root: 1 dispatch left N session dirs that each re-spawned a lane on
 * every restart until manually archived. Moving the dir to `-archive` removes it
 * from discovery; the transcript stays reviewable (archive-aware tail). Best-
 * effort per lane. Returns the number archived.
 */
export async function archiveLaneSessions(lanes: Lane[]): Promise<number> {
  const targets = interruptableSessions(lanes);
  if (targets.length === 0) return 0;
  let archived = 0;
  for (const target of targets) {
    try {
      if (target.sessionKey.startsWith('codex-owned:')) {
        const { archiveOwnedCodexSession } = await import('@/lib/codex/owned');
        await archiveOwnedCodexSession(target.sessionKey);
      } else if (target.sessionKey.startsWith('claude-code-owned:')) {
        const { archiveOwnedClaudeCodeSession } = await import('@/lib/claude-code/owned');
        await archiveOwnedClaudeCodeSession(target.sessionKey);
      } else if (target.sessionKey.startsWith('gemini-owned:')) {
        const { archiveOwnedGeminiSession } = await import('@/lib/gemini/owned');
        await archiveOwnedGeminiSession(target.sessionKey);
      } else if (target.sessionKey.startsWith('opencode-owned:')) {
        const { archiveOwnedOpencodeSession } = await import('@/lib/opencode/owned');
        await archiveOwnedOpencodeSession(target.sessionKey);
      } else {
        continue; // discovered / claude-code sessions own no dir under ~/.o8 to archive
      }
      archived += 1;
    } catch (error) {
      console.warn(`[reap-sessions] session-dir archive failed for lane ${target.laneId} (${target.runtime}):`, error);
    }
  }
  return archived;
}
