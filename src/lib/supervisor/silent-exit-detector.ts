/**
 * Silent-exit detector.
 *
 * #613 — codex / claude-code sessions occasionally die between
 * "typecheck done" and "git commit" without ever emitting the
 * completion-reported event that normally triggers
 * `autoCommitCompletionWorktree()` in ws-server.ts.
 *
 * Without this detector, a lane can sit in `running` or `reviewing`
 * forever with 3 uncommitted files in the worktree and no way for the
 * supervisor to know the agent is gone.
 *
 * Every 30s this module:
 *   1. Loads active lanes (status in `running`, `reviewing`, `awaiting_input`).
 *   2. For each lane with an attached session key, asks the owning runtime
 *      whether the underlying process / tmux session is still alive.
 *   3. If the session is gone AND the lane hasn't seen an event in 60s
 *      AND we haven't already processed the silent exit (idempotency via
 *      `lastEventLabel` prefix `silent_exit_`):
 *        a. Read `git status --porcelain` + commit count vs baseBranch.
 *        b. Dirty worktree → `autoCommitCompletionWorktree()` + `runCompletionVerification()`.
 *        c. Verification passes → mark lane `reviewing`, enqueue
 *           `silent_exit_but_work_present` (informational).
 *        d. Verification fails → mark lane `awaiting_input`, enqueue
 *           `silent_exit_verification_failed` (human review).
 *        e. Clean worktree + zero commits → mark lane `awaiting_input`,
 *           enqueue `silent_exit_no_work` (agent spawned but never built anything).
 *        f. Clean worktree + has commits → mark lane `reviewing`, enqueue
 *           `silent_exit_but_work_present` (lower priority — work exists).
 *
 * The detector is idempotent: once a silent_exit_* label sits on the lane,
 * subsequent ticks skip it. The lane status transition to `reviewing` /
 * `awaiting_input` also removes it from this detector's active-lane filter
 * anyway, but the label guard is belt-and-suspenders.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { isBridgeSessionAlive } from '@/lib/runtime/pty-bridge';
import {
  getLane,
  listActiveLanes,
  setLaneStatus,
} from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { findLiveCodexProcessByCwd } from '@/lib/runtimes/shared/codex-process-cwd';
import { lookupOwnedActiveRun } from '@/lib/runtimes/shared/owned-session-index';
import {
  autoCommitCompletionWorktree,
  runCompletionVerification,
} from '@/lib/supervisor/completion-verification';
import {
  enqueueSupervisorInboxItem,
  type SupervisorInboxKind,
  type SupervisorInboxPayload,
} from '@/lib/supervisor/heal-bot';

const execFileAsync = promisify(execFile);

const SILENT_EXIT_TICK_MS = 30_000;
const LANE_INACTIVITY_GRACE_MS = 300_000;
// #1293 — short grace before we PROBE a lane's session. The long grace above
// only matters when liveness is UNCERTAIN (don't yank a possibly-still-thinking
// agent). A DEFINITIVELY-dead owned session (process gone) should be salvaged as
// soon as it's been quiet briefly — otherwise a committed silent-exit sits
// `running` for 5 minutes. This also removes the salvage asymmetry: a candidate
// that committed its work emits more-recent lane events than one that didn't, so
// under a single long grace the committed one crossed the threshold much later.
const SILENT_EXIT_DEAD_GRACE_MS = 45_000;
const GIT_COMMAND_TIMEOUT_MS = 15_000;
const GIT_COMMAND_MAX_BUFFER = 10 * 1024 * 1024;

// Pipeline root fix (2026-07-03): `reviewing` is NOT interesting to this
// detector. A lane in `reviewing` has finished its work — its worker process
// being dead is the NORMAL state, not a silent exit. Probing reviewing lanes
// made this detector re-triage clean `agent_completed` completions ~60s later
// and overwrite them with `silent_exit_work_present`, which fed the terminal
// archiver and buried review-ready work (observed live, wave-1B). Silent-exit
// detection is for lanes whose process death is UNEXPECTED: running work and
// input waits only.
export const INTERESTING_LANE_STATUSES = new Set<Lane['status']>([
  'running',
  'awaiting_input',
]);

const SILENT_EXIT_EVENT_PREFIX = 'silent_exit_';
// Owned-session roots + the readdir/parse loop now live in the shared,
// TTL-memoized `owned-session-index` (perf 2026-07-03) — the DRY extraction the
// old duplicated-constants comment said was overdue.

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}


async function hasCodexWorktreeContinuity(
  surfaceId: string,
  worktreePath: string | null | undefined,
): Promise<boolean> {
  if (!surfaceId.startsWith('codex-owned:')) return false;
  return Boolean(await findLiveCodexProcessByCwd(worktreePath));
}

async function isOwnedSessionAlive(
  surfaceId: string,
  worktreePath?: string | null,
): Promise<boolean | undefined> {
  // Shared, TTL-memoized index (perf 2026-07-03): one readdir per root per tick
  // instead of one per-lane. Semantics unchanged — null=gone, {}=cleared.
  const run = await lookupOwnedActiveRun(surfaceId);
  if (!run) return await hasCodexWorktreeContinuity(surfaceId, worktreePath) ? true : false;
  // F44 — when session.json exists but `activeRun` is cleared (the runtime
  // store does this when the recorded pid dies, see owned-session/store.ts
  // line 253), readOwnedActiveRun returns `{}`. That's not "I can't tell" —
  // it's "session was definitively cleared." Promote to false so the
  // silent-exit triage runs and a clean-exit-with-diff lane graduates to
  // `reviewing`. Without this, F44 lanes stayed `running` for 45+ min after
  // Codex finished.
  if (run.tmuxSession === undefined && run.pid === undefined) {
    return await hasCodexWorktreeContinuity(surfaceId, worktreePath) ? true : false;
  }
  // Trust the tmux/bridge session first — it survives `zsh -l -c CMD` exec-ing
  // into the CLI, where the wrapper pid is replaced by the child pid and our
  // stored pid goes stale. If tmux exists AND is dead, we know the session is
  // gone. If tmux exists AND is alive, the session is alive regardless of pid.
  if (run.tmuxSession) {
    const bridgeAlive = await isBridgeSessionAlive(run.tmuxSession);
    if (bridgeAlive) return true;
    return await hasCodexWorktreeContinuity(surfaceId, worktreePath) ? true : false;
  }
  // No tmux session recorded (e.g. bridge failed to spawn) — fall back to pid.
  if (isPidAlive(run.pid)) return true;
  if (await hasCodexWorktreeContinuity(surfaceId, worktreePath)) return true;
  // pid was set but is now dead, with no tmux to confirm — bail rather than
  // miscategorize. The store will clear activeRun on its next pass and the
  // case above will then trigger the silent-exit triage.
  return undefined;
}

let detectorTimer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

interface WorktreeState {
  hasUncommittedWork: boolean;
  porcelain: string;
  commitsAhead: number;
  diffStat: string;
  lastCommit: string;
}

/**
 * Per-runtime liveness probe. Returns true when we are confident the session
 * is still alive, false when the session is clearly gone, and `undefined`
 * when we cannot tell (in which case the detector conservatively bails out
 * rather than miscategorize the lane).
 */
async function probeSessionAlive(lane: Lane): Promise<boolean | undefined> {
  const sessionKey = lane.sessionKey?.trim();
  if (!sessionKey) return undefined;

  if (
    sessionKey.startsWith('codex-owned:')
    || sessionKey.startsWith('gemini-owned:')
    || sessionKey.startsWith('opencode-owned:')
  ) {
    try {
      return await isOwnedSessionAlive(sessionKey, lane.worktreePath);
    } catch (error) {
      console.warn(`[silent-exit] Owned session probe failed for ${sessionKey}:`, error);
      return undefined;
    }
  }

  // Discovered codex terminals belong to the operator, not the IDE. We never
  // kill or mutate those sessions, so we also do not make claims about their
  // liveness — that would risk yanking a packet the operator is still driving
  // by hand. Skip silent-exit triage for them.
  if (sessionKey.startsWith('codex-live:') || sessionKey.startsWith('codex:')) {
    return undefined;
  }

  if (lane.runtime === 'claude-code') {
    // We have no sessionKey -> pid mapping for claude-code sessions because
    // the CLI writes to JSONL transcripts owned by the user. The cheap proxy
    // is to check whether any claude CLI process still has `lane.worktreePath`
    // (or `lane.repoPath`) as its cwd. If nothing matches, treat it as gone.
    try {
      const { findLiveClaudeProcesses } = await import('@/lib/runtimes/claude-code');
      const processes = await findLiveClaudeProcesses();
      const targetCwds = [lane.worktreePath, lane.repoPath]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value));
      if (targetCwds.length === 0) return undefined;
      if (processes.length === 0) return false;
      return processes.some((proc) => proc.cwd && targetCwds.includes(proc.cwd));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

async function readCommitCount(cwd: string, baseBranch: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-list', '--count', `${baseBranch}..HEAD`],
      { cwd, timeout: GIT_COMMAND_TIMEOUT_MS, maxBuffer: GIT_COMMAND_MAX_BUFFER },
    );
    const parsed = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

async function readPorcelain(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain'],
      { cwd, timeout: GIT_COMMAND_TIMEOUT_MS, maxBuffer: GIT_COMMAND_MAX_BUFFER },
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

async function readDiffStat(cwd: string, baseBranch: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--stat', `${baseBranch}...HEAD`],
      { cwd, timeout: GIT_COMMAND_TIMEOUT_MS, maxBuffer: GIT_COMMAND_MAX_BUFFER },
    );
    return stdout.trim() || 'No diff stat available.';
  } catch {
    return 'No diff stat available.';
  }
}

async function readLastCommit(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '-1', '--format=%H %s'],
      { cwd, timeout: GIT_COMMAND_TIMEOUT_MS, maxBuffer: GIT_COMMAND_MAX_BUFFER },
    );
    return stdout.trim() || 'No commits yet.';
  } catch {
    return 'Unavailable.';
  }
}

async function collectWorktreeState(cwd: string, baseBranch: string): Promise<WorktreeState> {
  const [porcelain, commitsAhead, diffStat, lastCommit] = await Promise.all([
    readPorcelain(cwd),
    readCommitCount(cwd, baseBranch),
    readDiffStat(cwd, baseBranch),
    readLastCommit(cwd),
  ]);
  return {
    porcelain,
    hasUncommittedWork: porcelain.length > 0,
    commitsAhead,
    diffStat,
    lastCommit,
  };
}

function buildInboxPayload(
  lane: Lane,
  state: WorktreeState,
  note: string,
  error?: string,
): SupervisorInboxPayload {
  return {
    laneId: lane.id,
    worktreePath: lane.worktreePath ?? lane.repoPath,
    sessionKey: lane.sessionKey ?? null,
    surfaceId: lane.sessionKey ?? null,
    baseBranch: lane.baseBranch,
    packetTitle: lane.label,
    packetReferenceLabel: null,
    verificationKind: null,
    attempts: null,
    error: error ?? note,
    diffStat: state.diffStat,
    lastCommit: state.lastCommit,
    transcriptTail: 'Session exited silently — no transcript tail available.',
    note,
    retryError: null,
  };
}

function enqueueSilentExitInbox(
  lane: Lane,
  kind: SupervisorInboxKind,
  payload: SupervisorInboxPayload,
): void {
  const inboxId = enqueueSupervisorInboxItem({
    repoPath: lane.repoPath,
    packetId: lane.packetId ?? null,
    kind,
    payload,
  });
  console.log(`[silent-exit] Enqueued inbox item ${inboxId} for lane ${lane.id} (${kind})`);
}

/**
 * Triage a single lane whose session has gone away silently. Returns true
 * when we took any action so the caller can log the outcome.
 */
async function triageSilentExit(lane: Lane): Promise<boolean> {
  const cwd = lane.worktreePath?.trim() || lane.repoPath;
  if (!cwd) {
    console.warn(`[silent-exit] Lane ${lane.id} has no worktree path — skipping triage.`);
    return false;
  }

  const state = await collectWorktreeState(cwd, lane.baseBranch);

  if (state.hasUncommittedWork) {
    try {
      const committed = await autoCommitCompletionWorktree(cwd);
      if (committed) {
        console.log(`[silent-exit] Auto-committed salvaged work in ${cwd} for lane ${lane.id}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[silent-exit] Auto-commit failed for lane ${lane.id}: ${message}`);
      setLaneStatus(lane.id, 'awaiting_input', 'system', 'silent_exit_autocommit_failed');
      enqueueSilentExitInbox(
        lane,
        'silent_exit_verification_failed',
        buildInboxPayload(
          lane,
          state,
          'Session exited silently with dirty worktree. Auto-commit attempt failed; operator triage required.',
          `autoCommitCompletionWorktree failed: ${message}`,
        ),
      );
      return true;
    }

    const verification = await runCompletionVerification(cwd, lane.baseBranch);
    if (!verification.ok) {
      console.warn(
        `[silent-exit] Lane ${lane.id} post-silent-exit ${verification.kind} failed`,
      );
      setLaneStatus(lane.id, 'awaiting_input', 'system', 'silent_exit_verification_failed');
      const postState = await collectWorktreeState(cwd, lane.baseBranch);
      enqueueSilentExitInbox(
        lane,
        'silent_exit_verification_failed',
        buildInboxPayload(
          lane,
          postState,
          `Session exited silently. Work was auto-committed but post-completion ${verification.kind} failed — operator triage required.`,
          verification.output || 'Verification reported a failure with no output.',
        ),
      );
      return true;
    }

    setLaneStatus(lane.id, 'reviewing', 'system', 'silent_exit_work_present');
    const postState = await collectWorktreeState(cwd, lane.baseBranch);
    enqueueSilentExitInbox(
      lane,
      'silent_exit_but_work_present',
      buildInboxPayload(
        lane,
        postState,
        'Session exited silently before reporting completion, but work was salvaged and typecheck + rule-check passed. Lane moved to reviewing.',
      ),
    );
    return true;
  }

  // Clean worktree branch.
  if (state.commitsAhead === 0) {
    const { parkHuddleReadyZeroDiffLane } = await import('@/lib/orchestrator/huddle-zero-diff');
    const huddlePark = await parkHuddleReadyZeroDiffLane(lane);
    if (huddlePark.parked) {
      console.log(`[silent-exit] Lane ${lane.id} completed its huddle turn with no changes; parked for orchestrator.`);
      return true;
    }
    setLaneStatus(lane.id, 'awaiting_input', 'system', 'silent_exit_no_work');
    enqueueSilentExitInbox(
      lane,
      'silent_exit_no_work',
      buildInboxPayload(
        lane,
        state,
        'Session exited silently with zero commits ahead of the base branch. No work was produced — agent likely failed before editing any files.',
      ),
    );
    return true;
  }

  // Clean worktree, has commits — normal completion never fired, but the
  // work is safely in the branch. Promote to review so the orchestrator
  // loop can pick it up.
  setLaneStatus(lane.id, 'reviewing', 'system', 'silent_exit_work_present');
  enqueueSilentExitInbox(
    lane,
    'silent_exit_but_work_present',
    buildInboxPayload(
      lane,
      state,
      `Session exited silently, but ${state.commitsAhead} commit(s) are already pushed to the lane branch. Promoted to reviewing.`,
    ),
  );
  return true;
}

// #23 — Auto-archive lanes whose Codex session is confirmed dead (silent_exit_* /
// zombie_reap) and which have sat stale past a grace window. Without this they
// stay in a non-terminal status forever ("orange" in the UI) when their work
// landed out-of-band (direct salvage, the dogfood loop, an update-relaunch).
// Archives BOTH the lane row and the owned-codex session dir so the UI/inventory
// clears on its own.
const ARCHIVE_DEAD_LANE_GRACE_MS = 30 * 60 * 1000;
// Pipeline root fix (2026-07-03): `silent_exit_work_present` REMOVED from the
// terminally-dead set. Work-present means committed, reviewable output exists —
// that lane is REVIEW-READY, not dead, and the operator (or orchestrator) owns
// its disposition. This archiver buried three review-ready wave-1B lanes
// (worktrees pruned, branches deleted) 30 minutes after a mislabel. Only
// genuinely workless terminal states are auto-archivable.
export const DEAD_LANE_EVENT_LABELS = new Set<string>([
  'silent_exit_no_work',
  'silent_exit_verification_failed',
  'zombie_reap',
]);
const ARCHIVABLE_STALE_STATUSES = new Set<Lane['status']>(['reviewing', 'recovering', 'awaiting_input']);

async function archiveTerminallyDeadLanes(now: number): Promise<void> {
  // listActiveLanes, not listLanes — the unfiltered read walked every archived
  // row every 30s tick for nothing (perf: O(all-ever-lanes) → O(active)).
  const { listActiveLanes: listActive, archiveLane } = await import('@/lib/lane/registry');
  const stale = listActive().filter((lane) => {
    if (!ARCHIVABLE_STALE_STATUSES.has(lane.status)) return false;
    if (!lane.lastEventLabel || !DEAD_LANE_EVENT_LABELS.has(lane.lastEventLabel)) return false;
    const ms = lane.lastEventAt ? new Date(lane.lastEventAt).getTime() : 0;
    return Number.isFinite(ms) && ms > 0 && now - ms > ARCHIVE_DEAD_LANE_GRACE_MS;
  });
  for (const lane of stale) {
    // Re-confirm the session is really dead so we never archive a revived one.
    const alive = await probeSessionAlive(lane);
    if (alive === true) continue;
    const refreshed = getLane(lane.id);
    if (!refreshed || !ARCHIVABLE_STALE_STATUSES.has(refreshed.status)) continue;
    try {
      archiveLane(lane.id, 'system');
      const key = lane.sessionKey?.trim();
      if (key?.startsWith('codex-owned:')) {
        const { archiveOwnedCodexSession } = await import('@/lib/codex/owned');
        await archiveOwnedCodexSession(key).catch(() => {});
      }
      console.log(`[silent-exit] Auto-archived stale dead lane ${lane.id} (${lane.lastEventLabel})`);
    } catch (error) {
      console.warn(`[silent-exit] Auto-archive failed for lane ${lane.id}:`, error);
    }
  }
}

async function silentExitTick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const now = Date.now();
    const lanes = listActiveLanes().filter((lane) => INTERESTING_LANE_STATUSES.has(lane.status));

    for (const lane of lanes) {
      if (!lane.sessionKey) continue;
      if (lane.lastEventLabel?.startsWith(SILENT_EXIT_EVENT_PREFIX)) continue;

      const lastEventMs = lane.lastEventAt ? new Date(lane.lastEventAt).getTime() : 0;
      const inactiveMs = Number.isFinite(lastEventMs) ? now - lastEventMs : 0;
      // Short grace before probing so a dead session doesn't sit for the full
      // 5-min window. The probe below gives the real verdict.
      if (inactiveMs < SILENT_EXIT_DEAD_GRACE_MS) {
        continue;
      }

      const alive = await probeSessionAlive(lane);
      if (alive === true) continue; // still alive — leave it
      // alive === undefined means we can't tell (e.g. a discovered/operator
      // session); keep the conservative long grace before acting. alive === false
      // is a definitively-dead owned session — salvage now.
      if (alive === undefined && inactiveMs < LANE_INACTIVITY_GRACE_MS) continue;

      // Re-read lane state to guard against concurrent updates between the
      // initial listActiveLanes() and our decision to act. If someone else
      // (heal-bot, supervisor) advanced the lane while we were probing, we
      // bail out rather than stomp their work.
      const refreshed = getLane(lane.id);
      if (!refreshed) continue;
      if (!INTERESTING_LANE_STATUSES.has(refreshed.status)) continue;
      if (refreshed.lastEventLabel?.startsWith(SILENT_EXIT_EVENT_PREFIX)) continue;

      try {
        await triageSilentExit(refreshed);
      } catch (error) {
        console.error(`[silent-exit] Triage failed for lane ${refreshed.id}:`, error);
      }
    }

    // #23 — sweep lanes already declared dead + stale into 'archived' so they
    // don't sit orange forever when their work landed out-of-band.
    await archiveTerminallyDeadLanes(now);
  } finally {
    tickInFlight = false;
  }
}

export function isSilentExitDetectorEnabled(): boolean {
  const raw = process.env.O8_SILENT_EXIT_DETECTOR_ENABLED;
  if (raw === undefined || raw === null) return true;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return true;
  return !(normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no');
}

export function startSilentExitDetector(): () => void {
  if (detectorTimer) {
    return () => {
      if (detectorTimer) {
        clearInterval(detectorTimer);
        detectorTimer = null;
      }
    };
  }

  detectorTimer = setInterval(() => {
    void silentExitTick().catch((error) => {
      console.error('[silent-exit] Tick failed:', error);
    });
  }, SILENT_EXIT_TICK_MS);
  if (detectorTimer.unref) detectorTimer.unref();

  console.log(`[silent-exit] Detector started (${SILENT_EXIT_TICK_MS}ms interval)`);

  // Fire-and-forget initial tick so we don't wait a full interval on boot.
  void silentExitTick().catch((error) => {
    console.error('[silent-exit] Initial tick failed:', error);
  });

  return () => {
    if (!detectorTimer) return;
    clearInterval(detectorTimer);
    detectorTimer = null;
    console.log('[silent-exit] Detector stopped');
  };
}

/**
 * Exposed for unit-like scripts (scripts/silent-exit-smoke.ts).
 * Runs a single triage pass for the given lane directly and returns whether
 * we took action. Call paths other than the recurring detector should
 * prefer this to avoid racing with `detectorTimer`.
 */
export async function runSilentExitTriageForLane(laneId: string): Promise<boolean> {
  const lane = getLane(laneId);
  if (!lane) return false;
  return triageSilentExit(lane);
}

/**
 * Testing hook — exposes the internal tick so scripts can exercise the full
 * detection path (including the grace / liveness gates) without running the
 * timer loop.
 */
export async function runSilentExitTickForTesting(): Promise<void> {
  await silentExitTick();
}
