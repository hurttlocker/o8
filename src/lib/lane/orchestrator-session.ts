/**
 * Resident Claude Code stream-json orchestrator. Each o8 chat owns one process,
 * Claude session, and carrier config directory; only stateless transport/auth is
 * shared. The process is warm across turns and resumes its Claude session after
 * config-driven recycling. Native, OpenRouter, and Codex-subscription carriers
 * all use this full interactive harness path; `-p` remains forbidden.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { listActiveLanesWithSessions } from '@/lib/lane/registry';
import { assertNoPrintFlag } from '@/lib/claude-code/assert-no-print-flag';
import {
  readOrchestratorBackendSessionId,
  writeOrchestratorBackendSessionId,
} from '@/lib/mobile/orchestrator-thread-history';
import {
  createToolCallTracker, parseOrchestratorTurnUsage,
  processStreamEvent,
  type OrchestratorEvent, type OrchestratorTurnUsage,
} from '@/lib/lane/orchestrator-stream-events';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { getRuntime, type RuntimeSession } from '@/lib/runtimes';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { toClaudeJson } from '@/lib/mcp/tool-spine/emit-claude';
import type { ToolProfile } from '@/lib/mcp/tool-spine/registry';
import { MODEL_IDS } from '@/lib/models';
import { fableEnvOverride } from '@/lib/lane/fable-profile';
import { assertOrchestratorRepoPath } from '@/lib/lane/repo-preflight';
import { buildOrchestratorSystemPrompt } from '@/lib/lane/orchestrator-system-prompt';
import { fingerprintMcpConfig, firstMcpConfigDivergence } from '@/lib/lane/orchestrator-mcp-fingerprint';
import { buildOrchestratorArgs } from '@/lib/lane/orchestrator-spawn-args';
import { pathWithNodeRuntime } from '@/lib/util/node-on-path';
import { resolveClaudeBinary } from '@/lib/runtimes/shared/cli-locate';
import {
  consumeResetSignal,
  ensureRegisteredSession,
  getRegisteredSession,
  normalizeRepoPath,
  normalizeThoughtsThreadId,
  orchestratorDataDir,
  PREEMPT_SETTLE_MS,
  PROCESS_TIMEOUT_MS,
  repoHash,
  requestRegisteredSessionReset,
  sessionNameForRepo,
  waitForSessionIdle,
  writeResetSignal,
} from './orchestrator-session-core';
import {
  crashSurvivableOrchestratorEnabled,
  createOrchestratorTurnRecord,
  createOrchestratorTurnRecordForFiles,
  discardOrchestratorTurnRecord,
  fileSize,
  finishOrchestratorTurn,
  isPidAlive,
  isRehydratedTurnAlive,
  listActiveOrchestratorTurns,
  openAppendFile,
  readJsonlLines,
  tailJsonlFile,
  updateOrchestratorTurnPid,
  type OrchestratorCrashSurvivalMeta,
  type OrchestratorTurnRecord,
} from './orchestrator-crash-survival';
import { getDataDir } from '@/lib/data-dir-migration';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import {
  nativeClaudeHarnessCarrier,
  resolveClaudeHarnessCarrier,
  type ClaudeHarnessCarrier,
} from './claude-harness-carrier';
// ── Types ──
export interface OrchestratorSession {
  sessionName: string;
  repoPath: string;
  /** UI/history thread id (thoughts-*), when this session belongs to a persisted chat. */
  threadId: string | null;
  /** Claude Code session ID for --resume continuity */
  claudeSessionId: string | null;
  status: 'ready' | 'busy' | 'dead';
  /** Currently-running child process (null when idle) */
  proc: ChildProcess | null;
  createdAt: number;
}

// ── Constants ──

/**
 * Resolve the claude binary at SPAWN time, not import time (#1551), through
 * the SHARED validated resolver (F6JHXW): the old local forever-cache stayed
 * stuck on a dead symlink chain while Claude's native auto-updater was
 * mid-swap — resolveClaudeBinary re-validates the cached path on every call
 * and re-scans the moment it dies, so a turn during the update window lands
 * on any healthy sibling install instead of `spawn … ENOENT`.
 */
function resolveClaudeBin(): string {
  return resolveClaudeBinary();
}
const ORCHESTRATOR_STATE_DIR = orchestratorDataDir('orchestrator');

const MCP_CONFIG_DIR = join(getDataDir(), 'mcp');
const LOG_PREFIX = '[orchestrator-rehydrate]';
/**
 * #457 — Kill the claude process if it doesn't finish within this window.
 *
 * Set to 8 minutes (was 90s). Review turns on Opus 4.7 that read multiple
 * agent transcripts, diff worktrees, run typecheck, and write a VERDICT block
 * legitimately take 3-5 minutes. The old 90s budget SIGKILLed review turns
 * mid-stream, which is what produced the "narrate-and-exit" failure mode —
 * the model would narrate a plan, start running tools, and get killed before
 * it could emit the final summary. Bumping this is the root fix.
 */
// Bumped 480_000 → 1_800_000 (8min → 30min) on 2026-05-23 after Opus 4.7
// hit the wall mid-investigation on #1113 — 83 tool calls deep into the
// tile-system exploration when the kill fired. The narrate-and-exit failure
// mode noted above is now mostly closed at this budget; architectural work
// fits comfortably.
//
// Bumped 1_800_000 → 14_400_000 (30min → 4hr) on 2026-06-17 — the 30min
// watchdog was SIGKILLing legitimate long turns where the orchestrator does
// deep direct work (a single turn doing an 11-file execFileSync hardening
// sweep blew past 30min and got killed mid-stream). This is a HANG watchdog,
// not a work budget: it clears the instant a turn closes normally (see the
// clearTimeout in the 'close'/'error' handlers), so a turn still alive at 4hr
// is wedged, not productive. The operator actively watches turns and can
// interrupt manually — this only reaps unattended hangs.

/**
 * Steer-Now / preempt settle window. A follow-up send fired while a turn is
 * still in flight (Steer-Now, or the steer-queue auto-fire) arrives ~immediately
 * after the interrupt SIGTERMs the prior subprocess — but `session.status` only
 * leaves 'busy' when `proc.on('close')` fires (~1-2s later, SIGKILL fallback at
 * 2s). Waiting that window out lets the dying turn settle so the new message is
 * accepted instead of being dropped with a hard "busy" rejection.
 */
let startupRehydrationPromise: Promise<void> | null = null;
let startupRehydrationComplete = false;
function writeOrchestratorResetSignal(repoPath: string, threadId?: string | null): void {
  writeResetSignal(ORCHESTRATOR_STATE_DIR, repoPath, threadId);
}

function consumeOrchestratorResetSignal(repoPath: string, threadId?: string | null): boolean {
  return consumeResetSignal(ORCHESTRATOR_STATE_DIR, repoPath, threadId);
}

function extractClaudeSessionId(sessionKey: string): string | null {
  return sessionKey.startsWith('claude-code:')
    ? sessionKey.slice('claude-code:'.length) || null
    : null;
}

function compareRehydrationCandidates(left: RuntimeSession, right: RuntimeSession) {
  const rank = (session: RuntimeSession) => {
    if (session.status === 'idle') return 0;
    if (session.status === 'reviewing') return 1;
    if (session.status === 'waiting') return 2;
    if (session.status === 'running') return 3;
    return 4;
  };

  const rankDelta = rank(left) - rank(right);
  if (rankDelta !== 0) {
    return rankDelta;
  }

  return right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
}

function buildRehydratedSession(repoPath: string, claudeSessionId: string, createdAt: number): OrchestratorSession {
  return {
    sessionName: orchestratorSessionName(repoPath),
    repoPath,
    threadId: null,
    claudeSessionId,
    status: 'ready',
    proc: null,
    createdAt,
  };
}

interface OrchestratorRehydrateOptions {
  onReboundEvent?: (record: OrchestratorTurnRecord, event: OrchestratorEvent) => void;
}

function rehydrateInflightClaudeTurn(record: OrchestratorTurnRecord, options: OrchestratorRehydrateOptions): boolean {
  if (record.backend !== 'claude') return false;
  const sessionName = record.sessionName || orchestratorSessionName(record.repoPath, record.threadId);
  let session = sessions.get(sessionName);
  if (!session) {
    session = {
      sessionName,
      repoPath: normalizeRepoPath(record.repoPath),
      threadId: normalizeThoughtsThreadId(record.threadId),
      claudeSessionId: readOrchestratorBackendSessionId(normalizeThoughtsThreadId(record.threadId), 'claude'),
      status: 'busy',
      proc: null,
      createdAt: record.startedAt,
    };
    sessions.set(sessionName, session);
  } else {
    session.status = 'busy';
  }

  const w = getWarmState(sessionName);
  const events: OrchestratorEvent[] = [];
  let resolved = false;
  const emit = (event: OrchestratorEvent) => {
    events.push(event);
    options.onReboundEvent?.(record, event);
  };
  const timeout = setTimeout(() => {}, PROCESS_TIMEOUT_MS);
  const turn: OrchestratorActiveTurn = {
    onEvent: emit,
    captureEvent: emit,
    resolve: () => { resolved = true; },
    reject: () => {},
    timeout,
    abortSignal: null,
    abortListener: null,
    settled: false,
    toolTracker: createToolCallTracker(),
    turnSessionId: session.claudeSessionId,
    cost: null,
    lastAssistantText: '',
    sawToolUseAfterText: false,
    launchAgentCallCount: 0,
    crashRecord: record,
    stopCrashTail: null,
  };
  turn.captureEvent = (event) => {
    emit(event);
    if (event.type === 'text') turn.lastAssistantText += event.text;
  };
  w.activeTurn = turn;

  const replay = readJsonlLines(record.stdoutPath, record.stdoutOffset ?? 0).lines;
  for (const line of replay) {
    if (!handleClaudeJsonLine(session, w, line)) break;
  }

  if (resolved || turn.settled) {
    return true;
  }

  if (!isRehydratedTurnAlive(record, PROCESS_TIMEOUT_MS)) {
    settleOrchestratorTurn(session, w, null);
    return true;
  }

  turn.stopCrashTail = tailJsonlFile({
    filePath: record.stdoutPath,
    fromOffset: fileSize(record.stdoutPath),
    alive: () => isRehydratedTurnAlive(record, PROCESS_TIMEOUT_MS) && !turn.settled,
    onLine: (line) => handleClaudeJsonLine(session!, w, line),
    onEnd: () => {
      if (!turn.settled) settleOrchestratorTurn(session!, w, null);
    },
  });
  console.log(`${LOG_PREFIX} Re-bound in-flight Claude orchestrator turn ${record.id} pid=${record.pid}`);
  return true;
}

export async function rehydrateOrchestratorSessions(options: OrchestratorRehydrateOptions = {}): Promise<void> {
  if (startupRehydrationComplete) {
    return;
  }
  if (startupRehydrationPromise) {
    return startupRehydrationPromise;
  }

  startupRehydrationPromise = (async () => {
    const activeLanes = listActiveLanesWithSessions();
    let reboundInflightTurns = 0;
    for (const record of listActiveOrchestratorTurns()) {
      try {
        if (rehydrateInflightClaudeTurn(record, options)) reboundInflightTurns += 1;
      } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to rehydrate in-flight turn ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (activeLanes.length === 0) {
      startupRehydrationComplete = true;
      return;
    }

    const runtimeIds = [...new Set(['claude-code', ...activeLanes.map((lane) => lane.runtime)])];
    const discoveredByRuntime = new Map<string, RuntimeSession[]>();

    for (const runtimeId of runtimeIds) {
      const runtime = getRuntime(runtimeId);
      if (!runtime?.capabilities.discover) {
        continue;
      }

      try {
        discoveredByRuntime.set(runtimeId, await runtime.discoverSessions());
      } catch (error) {
        console.warn(
          `${LOG_PREFIX} Failed to discover ${runtimeId} sessions during startup rehydration: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const liveLaneSessionKeys = new Set<string>();
    const reposNeedingRehydration = new Set<string>();

    for (const lane of activeLanes) {
      if (!lane.sessionKey) continue;
      const runtimeSessions = discoveredByRuntime.get(lane.runtime) ?? [];
      if (!runtimeSessions.some((session) => session.sessionKey === lane.sessionKey)) {
        continue;
      }

      liveLaneSessionKeys.add(lane.sessionKey);
      reposNeedingRehydration.add(normalizeRepoPath(lane.repoPath));
    }

    if (reposNeedingRehydration.size === 0) {
      startupRehydrationComplete = true;
      return;
    }

    const claudeSessions = (discoveredByRuntime.get('claude-code') ?? [])
      .filter((session) => session.status !== 'failed')
      .filter((session) => !liveLaneSessionKeys.has(session.sessionKey));

    let rehydratedCount = 0;

    for (const repoPath of reposNeedingRehydration) {
      const sessionName = orchestratorSessionName(repoPath);
      if (sessions.has(sessionName)) {
        continue;
      }

      const candidate = claudeSessions
        .filter((session) => normalizeRepoPath(session.cwd) === repoPath)
        .sort(compareRehydrationCandidates)[0];
      const claudeSessionId = candidate ? extractClaudeSessionId(candidate.sessionKey) : null;
      if (!candidate || !claudeSessionId) {
        continue;
      }

      sessions.set(
        sessionName,
        buildRehydratedSession(repoPath, claudeSessionId, candidate.lastActivityAt.getTime()),
      );
      rehydratedCount += 1;
      console.log(`${LOG_PREFIX} Rehydrated ${sessionName} from ${candidate.sessionKey}`);
    }

    console.log(
      `${LOG_PREFIX} Startup scan checked ${activeLanes.length} active lane${activeLanes.length === 1 ? '' : 's'}, restored ${rehydratedCount} orchestrator session${rehydratedCount === 1 ? '' : 's'}, re-bound ${reboundInflightTurns} in-flight turn${reboundInflightTurns === 1 ? '' : 's'}`,
    );
    startupRehydrationComplete = true;
  })()
    .finally(() => {
      startupRehydrationPromise = null;
    });

  return startupRehydrationPromise;
}

/** Generate a temporary MCP config file for orchestrator context sources.
 *
 * `profile` selects the tool surface: `'full'` (default) is unchanged — same
 * path, byte-identical content. `'propose'` (Collide proposer) strips the
 * operator server and writes to a SEPARATE `-propose` file so a concurrent
 * full-profile turn for the same repo can never clobber it back to a config
 * that carries dispatch (the #1075 lockout would otherwise race). `'fable'`
 * likewise gets its own `-fable` file (keeps operator + cortex, strips externals)
 * so a concurrent full turn for the same repo can't clobber its surface either. */
type ClaudeMcpConfig = ReturnType<typeof toClaudeJson>;

function ensureMcpConfig(repoPath: string, profile: ToolProfile, config: ClaudeMcpConfig): string {
  if (!existsSync(MCP_CONFIG_DIR)) mkdirSync(MCP_CONFIG_DIR, { recursive: true });

  const suffix = profile === 'full' ? '' : `-${profile}`;
  const configPath = join(MCP_CONFIG_DIR, `orchestrator-${repoHash(repoPath)}${suffix}.json`);
  // The caller fingerprints this exact object. Keeping construction out of the
  // writer prevents transient resolver state from making the stored hash differ
  // from the config the CLI actually reads.
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`[orchestrator-session] MCP config written to ${configPath}`);
  return configPath;
}

// ── Registry ──

const sessions = new Map<string, OrchestratorSession>();

export function orchestratorSessionName(repoPath: string, threadId?: string | null): string {
  return sessionNameForRepo('cortex-orchestrator', repoPath, threadId);
}

export function getOrchestratorSession(repoPath: string, threadId?: string | null): OrchestratorSession | null {
  void rehydrateOrchestratorSessions().catch(() => {
    // Startup rehydration is best-effort; callers can still create a fresh session.
  });
  return getRegisteredSession(sessions, orchestratorSessionName(repoPath, threadId));
}

export function requestOrchestratorSessionReset(repoPath: string, threadId?: string | null): { repoPath: string; sessionName: string; threadId: string | null } {
  const result = requestRegisteredSessionReset(sessions, {
    repoPath,
    threadId,
    sessionNameFor: orchestratorSessionName,
    resetExisting: (session, sessionName) => {
      session.claudeSessionId = null;
      // Reset = fresh conversation — recycle the resident proc (it holds the old one).
      if (session.proc) killOrchestratorProc(session, getWarmState(sessionName));
    },
    resetPersistedThread: (normalizedThreadId) => writeOrchestratorBackendSessionId(normalizedThreadId, 'claude', null),
  });
  writeOrchestratorResetSignal(result.repoPath, result.threadId);
  return result;
}

/**
 * Request a graceful orchestrator reload. Unlike `requestOrchestratorSessionReset`,
 * this PRESERVES the `claudeSessionId` so the next user turn resumes the
 * existing transcript via `--resume`. A RESIDENT proc bakes its MCP config at
 * spawn, so we recycle it here (the mcpConfigHash check would catch it on the
 * next turn anyway, but recycling now makes the config change take effect
 * immediately). Used by the conversational `cortex.register_mcp` flow.
 *
 * Callers are expected to also broadcast a `notice` event to WS subscribers
 * so the UI can show a reload banner (see ws-server `/internal/orchestrator-reload`).
 */
export function reloadOrchestratorSession(repoPath: string, threadId?: string | null): {
  repoPath: string;
  sessionName: string;
  threadId: string | null;
  claudeSessionId: string | null;
} {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const normalizedThreadId = normalizeThoughtsThreadId(threadId);
  const sessionName = orchestratorSessionName(normalizedRepoPath, normalizedThreadId);
  const session = sessions.get(sessionName);
  // MCP-config change → recycle the resident proc so the next turn spawns with
  // the new config (a resident proc bakes config at spawn).
  if (session?.proc) killOrchestratorProc(session, getWarmState(sessionName));
  return {
    repoPath: normalizedRepoPath,
    sessionName,
    threadId: normalizedThreadId,
    claudeSessionId: session?.claudeSessionId ?? null,
  };
}

// ── Ensure session exists ──

export function ensureOrchestratorSession(repoPath: string, threadId?: string | null): OrchestratorSession {
  void rehydrateOrchestratorSessions().catch(() => {
    // Startup rehydration is best-effort; callers can still create a fresh session.
  });

  return ensureRegisteredSession(sessions, {
    repoPath,
    threadId,
    sessionNameFor: orchestratorSessionName,
    logPrefix: '[orchestrator-session]',
    create: (normalizedRepoPath, normalizedThreadId, sessionName) => ({
      sessionName,
      repoPath: normalizedRepoPath,
      threadId: normalizedThreadId,
      claudeSessionId: readOrchestratorBackendSessionId(normalizedThreadId, 'claude'),
      status: 'ready',
      proc: null,
      createdAt: Date.now(),
    }),
  });
}

// ── Send message (spawn process, stream JSON) ──

/**
 * Permission mode passed to Claude Code when spawning the orchestrator.
 *
 * - `'full'`: current behavior — spawns with `--dangerously-skip-permissions`
 *   so Claude can act autonomously on files, run commands, and drive MCP
 *   tools without prompting. Used by automated paths (intake, auto-review)
 *   and by user messages sent with the "Full access" chip armed.
 * - `'plan'`: spawns with `--permission-mode plan` so Claude can read and
 *   call MCP tools freely but any write (Edit / Write / Bash side-effects)
 *   must be explicitly approved by the user. Used when the chat's permission
 *   chip is toggled to "Read-only" — the safe-mode orchestrator.
 */
export type OrchestratorPermissionMode = 'full' | 'plan';
export const DEFAULT_ORCHESTRATOR_MODEL = MODEL_IDS.orchestratorDefault;

export interface SendToOrchestratorOptions {
  permissionMode?: OrchestratorPermissionMode;
  /**
   * MCP tool profile. `'propose'` (Collide proposer) strips the operator
   * (dispatch) server from this turn's MCP config — the run can read + use
   * cortex but cannot dispatch work. Defaults to `'full'`. See `ToolProfile`.
   */
  toolProfile?: ToolProfile;
  thinkingEffort?: ThinkingEffort;
  model?: string;
  /**
   * #624 — Abort signal for user-initiated interrupt. When aborted mid-stream,
   * the in-flight claude CLI subprocess is terminated with SIGTERM so the turn
   * ends within 1-2s. Partial transcript output that already fired via onEvent
   * is preserved — only NEW output is stopped.
   */
  signal?: AbortSignal;
  /**
   * Image attachments from the composer's picture pills. Converted into
   * base64 image content blocks on the stream-json stdin turn so the
   * model actually SEES them (the wire used to drop these silently).
   */
  attachments?: Array<{ dataUri: string; name?: string }>;
  crashSurvival?: OrchestratorCrashSurvivalMeta;
}

/** data:image/png;base64,xxxx → an Anthropic image content block. */
function attachmentToImageBlock(att: { dataUri: string }): { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(att.dataUri);
  if (!match) return null;
  return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
}

// ── Warm resident-process pool ──
// Each orchestrator chat keeps one resident process. Its baked cwd, model,
// permissions, tools, effort, MCP config, and carrier fingerprint determine
// whether the process can stay warm or must recycle and resume its session.
//
// LOCKOUT: a resident proc keeps stdin OPEN, which removes the
// "stdin closes ⇒ an approval can never be answered" layer of the proposer
// read-only guarantee. So a PLAN-mode proc that emits ANY permission request
// (can_use_tool / ExitPlanMode) is KILLED on the spot — the strongest possible
// auto-deny, and one that needs no knowledge of the (UNDOCUMENTED) stream-json
// permission-response envelope. The proc dies before the tool can execute;
// assertNoPrintFlag and assertProposerEventAllowed remain the backstops.

const IDLE_REAP_MS = 30 * 60_000;
const MAX_LIVE_PROCS = 4; // mirror the Brain warm-pool cap
interface OrchestratorProcConfig {
  cwd: string;
  model: string;
  permissionMode: OrchestratorPermissionMode;
  toolProfile: ToolProfile;
  effort: ThinkingEffort;
  mcpConfigPath: string;
  mcpConfigHash: string;
  mcpConfigMaterial: string;
  modelSource: string;
  carrierFingerprint: string;
}
interface OrchestratorActiveTurn {
  onEvent: (e: OrchestratorEvent) => void;
  captureEvent: (e: OrchestratorEvent) => void;
  resolve: () => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  abortSignal: AbortSignal | null;
  abortListener: (() => void) | null;
  settled: boolean;
  toolTracker: ReturnType<typeof createToolCallTracker>;
  turnSessionId: string | null;
  cost: number | null;
  usage?: OrchestratorTurnUsage | null;
  lastAssistantText: string;
  sawToolUseAfterText: boolean;
  launchAgentCallCount: number;
  crashRecord: OrchestratorTurnRecord | null;
  stopCrashTail: (() => void) | null;
}
interface WarmState {
  procConfig: OrchestratorProcConfig | null;
  activeTurn: OrchestratorActiveTurn | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  stdoutLineBuffer: string;
  stderrBuffer: string;
  lastUsedAt: number;
  crashStdoutPath: string | null;
  crashStderrPath: string | null;
}
const warmStates = new Map<string, WarmState>();

export function getWarmState(sessionName: string): WarmState {
  let w = warmStates.get(sessionName);
  if (!w) {
    w = { procConfig: null, activeTurn: null, idleTimer: null, stdoutLineBuffer: '', stderrBuffer: '', lastUsedAt: Date.now(), crashStdoutPath: null, crashStderrPath: null };
    warmStates.set(sessionName, w);
  }
  return w;
}

function procConfigMatches(a: OrchestratorProcConfig | null, b: OrchestratorProcConfig): boolean {
  return !!a && a.cwd === b.cwd && a.model === b.model && a.permissionMode === b.permissionMode
    && a.toolProfile === b.toolProfile && a.effort === b.effort && a.mcpConfigHash === b.mcpConfigHash
    && a.modelSource === b.modelSource && a.carrierFingerprint === b.carrierFingerprint;
}

function firstProcConfigDivergence(a: OrchestratorProcConfig | null, b: OrchestratorProcConfig): string {
  if (!a) return 'procConfig';
  for (const key of ['cwd', 'model', 'permissionMode', 'toolProfile', 'effort', 'modelSource', 'carrierFingerprint'] as const) {
    if (a[key] !== b[key]) return key;
  }
  if (a.mcpConfigHash !== b.mcpConfigHash) {
    const key = firstMcpConfigDivergence(a.mcpConfigMaterial, b.mcpConfigMaterial);
    return `${key} (${a.mcpConfigHash}->${b.mcpConfigHash})`;
  }
  return 'procConfig';
}

function clearIdleTimer(w: WarmState): void {
  if (w.idleTimer) { clearTimeout(w.idleTimer); w.idleTimer = null; }
}

function scheduleIdleReap(session: OrchestratorSession, w: WarmState): void {
  clearIdleTimer(w);
  if (session.status === 'dead' || !session.proc) return;
  w.idleTimer = setTimeout(() => {
    console.log(`[orchestrator-session] idle-reap ${session.sessionName}`);
    killOrchestratorProc(session, w);
  }, IDLE_REAP_MS);
}

/** SIGTERM (then SIGKILL) the resident proc; the session recycles next turn. */
function killOrchestratorProc(session: OrchestratorSession, w: WarmState): void {
  clearIdleTimer(w);
  const proc = session.proc;
  session.proc = null;
  w.procConfig = null;
  w.crashStdoutPath = null;
  w.crashStderrPath = null;
  session.status = 'dead';
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    proc.kill('SIGTERM');
    setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }, 2_000);
  }
}

function liveOrchestratorProcCount(): number {
  let n = 0;
  for (const s of sessions.values()) if (s.proc) n += 1;
  return n;
}

/** At MAX_LIVE, reap the least-recently-used IDLE proc (never a busy one). */
function reapIdleForCapacity(exceptSessionName: string): void {
  if (liveOrchestratorProcCount() < MAX_LIVE_PROCS) return;
  let lru: { session: OrchestratorSession; w: WarmState } | null = null;
  for (const s of sessions.values()) {
    if (s.sessionName === exceptSessionName || !s.proc || s.status !== 'ready') continue;
    const w = warmStates.get(s.sessionName);
    if (!w) continue;
    if (!lru || w.lastUsedAt < lru.w.lastUsedAt) lru = { session: s, w };
  }
  if (lru) {
    console.log(`[orchestrator-session] MAX_LIVE (${MAX_LIVE_PROCS}) — reaping idle ${lru.session.sessionName}`);
    killOrchestratorProc(lru.session, lru.w);
  }
}

/** ExitPlanMode / can_use_tool / control_request — the escalate-to-execute gate
 *  that a resident PLAN-mode proc must never get answered. */
const PERMISSION_TOOL_NAMES = new Set(['ExitPlanMode', 'exit_plan_mode', 'permission_request', 'request_permission']);
export function detectPermissionRequest(raw: Record<string, unknown>): boolean {
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (type === 'can_use_tool' || type === 'control_request' || type === 'permission_request') return true;
  const bareName = typeof raw.name === 'string' ? raw.name
    : typeof raw.tool_name === 'string' ? raw.tool_name
      : typeof raw.tool === 'string' ? raw.tool : '';
  if (bareName && PERMISSION_TOOL_NAMES.has(bareName)) return true;
  const block = raw.content_block as Record<string, unknown> | undefined;
  if (block && block.type === 'tool_use' && typeof block.name === 'string' && PERMISSION_TOOL_NAMES.has(block.name)) return true;
  const content = (raw.message as Record<string, unknown> | undefined)?.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      const bb = b as Record<string, unknown> | null;
      if (bb && bb.type === 'tool_use' && typeof bb.name === 'string' && PERMISSION_TOOL_NAMES.has(bb.name)) return true;
    }
  }
  return false;
}

/** Settle the active turn — emit `done` (+ an error event on a bad crash), run
 *  the narrate-and-exit / false-dispatch telemetry, resolve, and (if the proc is
 *  still alive) leave it READY + schedule the idle reap. */
function settleOrchestratorTurn(session: OrchestratorSession, w: WarmState, error: Error | null): void {
  const turn = w.activeTurn;
  if (!turn || turn.settled) return;
  const hadCrashRecord = !!turn.crashRecord;
  turn.settled = true;
  clearTimeout(turn.timeout);
  turn.stopCrashTail?.();
  turn.stopCrashTail = null;
  finishOrchestratorTurn(turn.crashRecord, error ? 'failed' : 'completed');
  turn.crashRecord = null;
  if (turn.abortSignal && turn.abortListener) {
    turn.abortSignal.removeEventListener('abort', turn.abortListener);
    turn.abortListener = null;
  }
  w.activeTurn = null;
  w.lastUsedAt = Date.now();
  if (turn.turnSessionId) session.claudeSessionId = turn.turnSessionId;

  if (!error) {
    const tail = turn.lastAssistantText.trim().slice(-1200);
    const hasSummaryMarker = /VERDICT\s*[#-]|Dispatched\s+\d+\s+agent/i.test(tail);
    if (turn.sawToolUseAfterText || !hasSummaryMarker) {
      console.warn(`[orchestrator-session] narrate-and-exit suspected for ${session.sessionName}: sawToolUseAfterText=${turn.sawToolUseAfterText} hasSummaryMarker=${hasSummaryMarker} tailLen=${tail.length}`);
    }
    const dispatchClaimPattern = /\b(dispatched|launched|fired|launching|polling|kicked off)\b/i;
    if (turn.launchAgentCallCount === 0 && dispatchClaimPattern.test(turn.lastAssistantText)) {
      console.warn(`[orchestrator-session] FALSE-DISPATCH suspected for ${session.sessionName}: launchAgentCallCount=0 but text claims dispatch — text sample: ${JSON.stringify(turn.lastAssistantText.slice(-200))}`);
    }
  }

  turn.onEvent({ type: 'done', sessionId: turn.turnSessionId, cost: turn.cost, ...(turn.usage ? { usage: turn.usage } : {}) });
  if (error) turn.onEvent({ type: 'error', error: error.message });

  if ((session.proc || hadCrashRecord) && session.status !== 'dead') {
    session.status = 'ready';
    scheduleIdleReap(session, w);
  }
  turn.resolve();
}

function handleClaudeJsonLine(session: OrchestratorSession, w: WarmState, line: string): boolean {
  if (!line.trim()) return true;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(line) as Record<string, unknown>; } catch { return true; }

  // LOCKOUT auto-deny — a plan-mode proc that asks to escalate is killed.
  if (w.procConfig?.permissionMode === 'plan' && detectPermissionRequest(raw)) {
    console.warn(`[orchestrator-session] LOCKOUT auto-deny — plan-mode proc ${session.sessionName} emitted a permission request; killing (write blocked).`);
    settleOrchestratorTurn(session, w, null); // proposal text already captured
    killOrchestratorProc(session, w);
    return false;
  }

  const turn = w.activeTurn;
  if (!turn) return true; // stray output between turns
  processStreamEvent(raw, turn.captureEvent, (id) => { turn.turnSessionId = id; }, (c) => { turn.cost = c; }, turn.toolTracker);
  if (raw.type === 'result') {
    turn.usage = parseOrchestratorTurnUsage(raw);
    settleOrchestratorTurn(session, w, null);
    return false;
  }
  return true;
}

export function attachOrchestratorProcHandlers(session: OrchestratorSession, w: WarmState): void {
  const proc = session.proc;
  if (!proc) return;

  // Every handler below is identity-guarded: after a recycle
  // (killOrchestratorProc nulls session.proc, then a NEW proc spawns), the OLD
  // proc's stdout tail / close / error events still fire on the event loop.
  // Without the guard the old close settled the NEW turn as "proc exited with
  // code 143" and clobbered session.proc — every recycle-triggering turn died
  // instantly (live-hit 2026-07-13). Deliberate kill paths (timeout, interrupt,
  // LOCKOUT, recycle) settle their turn explicitly before killing, so skipping
  // the stale close loses nothing.
  proc.stdout?.on('data', (chunk: Buffer) => {
    if (session.proc !== proc) return;
    w.stdoutLineBuffer += chunk.toString('utf-8');
    const lines = w.stdoutLineBuffer.split('\n');
    w.stdoutLineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!handleClaudeJsonLine(session, w, line)) return;
    }
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    if (session.proc !== proc) return;
    w.stderrBuffer += chunk.toString('utf-8');
    if (w.stderrBuffer.length > 4_000) w.stderrBuffer = w.stderrBuffer.slice(-4_000);
  });

  proc.on('error', (err) => {
    if (session.proc !== proc) return;
    clearIdleTimer(w);
    session.proc = null;
    w.procConfig = null;
    session.status = 'dead';
    const turn = w.activeTurn;
    if (turn && !turn.settled) {
      turn.settled = true;
      clearTimeout(turn.timeout);
      w.activeTurn = null;
      turn.onEvent({ type: 'error', error: err.message });
      turn.reject(err);
    }
  });

  proc.on('close', (code) => {
    if (session.proc !== proc) return;
    clearIdleTimer(w);
    session.proc = null;
    w.procConfig = null;
    if (w.activeTurn && !w.activeTurn.settled) {
      // Crashed / killed mid-turn — flush the tail then settle (error event only
      // on a non-clean exit, matching the cold path).
      if (w.stdoutLineBuffer.trim()) {
        try {
          const raw = JSON.parse(w.stdoutLineBuffer) as Record<string, unknown>;
          const turn = w.activeTurn;
          processStreamEvent(raw, turn.captureEvent, (id) => { turn.turnSessionId = id; }, (c) => { turn.cost = c; }, turn.toolTracker);
          if (raw.type === 'result') turn.usage = parseOrchestratorTurnUsage(raw);
        } catch { /* ignore */ }
      }
      w.stdoutLineBuffer = '';
      const stderr = w.stderrBuffer.trim();
      settleOrchestratorTurn(session, w, code === 0 || code === null ? null : new Error(stderr.slice(0, 500) || `orchestrator proc exited with code ${code}`));
    }
    session.status = 'dead'; // proc gone → next turn respawns (auto-recover)
  });
}

/** Spawn a fresh resident proc with the baked config. First-turn cold. */
function spawnOrchestratorProc(session: OrchestratorSession, w: WarmState, config: OrchestratorProcConfig, carrierEnv: Record<string, string>): void {
  // Layer B — a Fable turn keeps `--dangerously-skip-permissions` (kept MCP tools
  // run autonomously) AND adds `--disallowedTools <native>` to strip Claude's
  // native read/write tools (the token lever). isFable takes precedence over the
  // plan branch so the lockout holds regardless of permission mode. See
  // `fable-profile.ts` for the empirical basis.
  const isFable = config.toolProfile === 'fable' || config.toolProfile === 'fable-solo';
  const args = buildOrchestratorArgs({
    permissionMode: config.permissionMode,
    toolProfile: config.toolProfile,
    effort: config.effort,
    mcpConfigPath: config.mcpConfigPath,
    model: config.model,
    claudeSessionId: session.claudeSessionId,
    systemPrompt: buildOrchestratorSystemPrompt(session.repoPath),
  });

  // The orchestrator must stay on the interactive REPL path for every carrier.
  assertNoPrintFlag(args, 'Orchestrator REPL session');

  let crashRecord: OrchestratorTurnRecord | null = null;
  let stdoutFd: number | null = null;
  let stderrFd: number | null = null;
  const crashEnabled = crashSurvivableOrchestratorEnabled();
  if (crashEnabled) {
    crashRecord = createOrchestratorTurnRecord({
      backend: 'claude',
      sessionName: session.sessionName,
      repoPath: session.repoPath,
      threadId: session.threadId,
      pid: 0,
    });
    stdoutFd = openAppendFile(crashRecord.stdoutPath);
    stderrFd = openAppendFile(crashRecord.stderrPath);
  }
  // Preflight the cwd (#1551, shared helper): missing folder OR non-git folder
  // fails here with a human-actionable message instead of "spawn claude ENOENT"
  // (which names the healthy binary) or a confusing mid-turn tool error.
  assertOrchestratorRepoPath(session.repoPath);
  const launch = cliInvocation(resolveClaudeBin(), args);
  const proc = spawn(launch.command, launch.args, { windowsHide: true,
    cwd: session.repoPath,
    // Fable key injection stays scoped; the selected harness carrier contributes
    // only its explicit environment through carrierEnv.
    env: {
      ...process.env,
      // claude is a node shim on some installs — server's runtime on PATH (#1551).
      PATH: pathWithNodeRuntime(),
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      O8_MANAGED_SESSION: '1',
      ...carrierEnv,
      ...(isFable ? fableEnvOverride() : {}),
    },
    detached: crashEnabled,
    stdio: crashEnabled && stdoutFd !== null && stderrFd !== null
      ? ['pipe', stdoutFd, stderrFd]
      : ['pipe', 'pipe', 'pipe'],
  });
  if (stdoutFd !== null) closeSync(stdoutFd);
  if (stderrFd !== null) closeSync(stderrFd);
  if (crashEnabled) proc.unref();
  if (crashRecord) {
    const updated = updateOrchestratorTurnPid(crashRecord, proc.pid ?? 0);
    w.crashStdoutPath = updated.stdoutPath;
    w.crashStderrPath = updated.stderrPath;
    // This record only allocated the warm proc's stream files — per-turn
    // records are created per send. Discard, don't settle (task #8 ledger).
    discardOrchestratorTurnRecord(updated);
  }
  session.proc = proc;
  w.procConfig = config;
  w.stdoutLineBuffer = '';
  w.stderrBuffer = '';
  attachOrchestratorProcHandlers(session, w);
  console.log(`[orchestrator-session] spawned warm proc ${session.sessionName} (${config.permissionMode}/${config.toolProfile})`);
}

/**
 * Sends a message to the orchestrator through its RESIDENT `claude` process
 * (warm-pool). Spawns on the first turn / after a config change; reuses the
 * live process on every turn after. Calls `onEvent` for each parsed event;
 * resolves when the turn settles on the stream `result`.
 */
export async function sendToOrchestrator(
  session: OrchestratorSession,
  message: string,
  onEvent: (event: OrchestratorEvent) => void,
  options: SendToOrchestratorOptions = {},
): Promise<void> {
  const permissionMode: OrchestratorPermissionMode = options.permissionMode ?? 'full';
  const thinkingEffort: ThinkingEffort = options.thinkingEffort ?? 'adaptive';
  const requestedModel = options.model?.trim() || DEFAULT_ORCHESTRATOR_MODEL;
  const toolProfile: ToolProfile = options.toolProfile ?? 'full';
  const w = getWarmState(session.sessionName);

  // Steer-Now / queue preempt: the ws-server aborts the prior turn's
  // controller before calling sendTurn, so a still-'busy' session here means a
  // just-interrupted subprocess that's mid-teardown. Wait for it to close
  // rather than rejecting the steered message outright.
  if (session.status === 'busy') {
    await waitForSessionIdle(session, PREEMPT_SETTLE_MS);
  }

  // #457 — Auto-recover dead sessions by creating a fresh one. A SIGTERM'd turn
  // exits non-zero → 'dead', so the settle wait above commonly lands here.
  if (session.status === 'dead') {
    console.log(`[orchestrator-session] Auto-recovering dead session ${session.sessionName}`);
    session.status = 'ready';
    session.claudeSessionId = null;
    session.proc = null;
    w.procConfig = null;
  }
  // Still busy after the settle window — a genuinely concurrent turn that was
  // never interrupted, or a hung proc. Reject as before. The `session.status =
  // 'busy'` claim below is synchronous (no await before the spawn), so a second
  // waiter that lost the race re-enters here and rejects instead of double-spawning.
  if (session.status === 'busy') {
    throw new Error('Orchestrator session is busy');
  }

  // #1551 — preflight the repo path before ANY per-turn work (MCP config,
  // warm-proc spawn). Missing folder OR non-git folder fails with a
  // human-actionable message instead of "spawn claude ENOENT".
  assertOrchestratorRepoPath(session.repoPath);

  const isFableProfile = toolProfile === 'fable' || toolProfile === 'fable-solo';
  let carrier: ClaudeHarnessCarrier;
  try {
    carrier = isFableProfile
      ? nativeClaudeHarnessCarrier(requestedModel)
      : await resolveClaudeHarnessCarrier({
          requestedModel,
          sessionDir: join(ORCHESTRATOR_STATE_DIR, 'carrier', session.sessionName),
        });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    onEvent({ type: 'error', error: failure.message });
    throw failure;
  }
  const model = carrier.model;

  if (consumeOrchestratorResetSignal(session.repoPath, session.threadId)) {
    session.claudeSessionId = null;
    // A reset means a fresh conversation — recycle the warm proc (it holds the old one).
    if (session.proc) killOrchestratorProc(session, w);
  }

  // Write the MCP config (idempotent) + compute the desired resident-proc config.
  // A 'propose' turn gets the operator-stripped read-only surface — Collide's
  // lockout. The config baked into the resident proc is compared each turn.
  const mcpConfig = toClaudeJson(buildToolRegistry(session.repoPath, { profile: toolProfile }));
  const mcpFingerprint = fingerprintMcpConfig(mcpConfig);
  const mcpConfigPath = ensureMcpConfig(session.repoPath, toolProfile, mcpConfig);
  const desiredConfig: OrchestratorProcConfig = {
    cwd: session.repoPath,
    model,
    permissionMode,
    toolProfile,
    effort: thinkingEffort,
    mcpConfigPath,
    mcpConfigHash: mcpFingerprint.hash,
    mcpConfigMaterial: mcpFingerprint.material,
    modelSource: carrier.source,
    carrierFingerprint: carrier.fingerprint,
  };

  // Recycle the resident proc when its baked config no longer matches (model /
  // permission mode / tool profile / effort / MCP-config content change).
  if (session.proc && !procConfigMatches(w.procConfig, desiredConfig)) {
    const divergence = firstProcConfigDivergence(w.procConfig, desiredConfig);
    console.log(`[orchestrator-session] recycle ${session.sessionName} — config changed at ${divergence}`);
    killOrchestratorProc(session, w);
  }

  // Spawn a fresh proc when there's no warm one (first turn / after recycle).
  if (!session.proc) {
    reapIdleForCapacity(session.sessionName);
    try {
      spawnOrchestratorProc(session, w, desiredConfig, carrier.spawnEnv);
    } catch (error) {
      session.status = 'dead';
      const e = error instanceof Error ? error : new Error(String(error));
      onEvent({ type: 'error', error: e.message });
      throw e;
    }
  }

  session.status = 'busy';
  clearIdleTimer(w);

  // Build the message payload (attachments → image blocks). Same CLI contract
  // as interactive-session.ts; the message is written to the RESIDENT proc's
  // still-open stdin (no stdin.end() — the proc lives on for the next turn).
  const imageBlocks = (options.attachments ?? [])
    .map(attachmentToImageBlock)
    .filter((block): block is NonNullable<typeof block> => block !== null);
  const content: string | Array<Record<string, unknown>> = imageBlocks.length > 0
    ? [{ type: 'text', text: message }, ...imageBlocks]
    : message;
  const payload = `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;

  return new Promise<void>((resolvePromise, rejectPromise) => {
    const proc = session.proc;
    if (!proc || !proc.stdin || proc.stdin.destroyed) {
      session.status = 'dead';
      const e = new Error('Orchestrator resident proc stdin is not writable');
      onEvent({ type: 'error', error: e.message });
      rejectPromise(e);
      return;
    }

    const crashOffset = w.crashStdoutPath ? fileSize(w.crashStdoutPath) : 0;
    const crashRecord = crashSurvivableOrchestratorEnabled() && w.crashStdoutPath && w.crashStderrPath && proc.pid
      ? createOrchestratorTurnRecordForFiles({
          backend: 'claude',
          sessionName: session.sessionName,
          repoPath: session.repoPath,
          threadId: options.crashSurvival?.threadId ?? session.threadId,
          pid: proc.pid,
          stdoutPath: w.crashStdoutPath,
          stderrPath: w.crashStderrPath,
          stdoutOffset: crashOffset,
          assistantMessageId: options.crashSurvival?.assistantMessageId ?? null,
          assistantStartedAtMs: options.crashSurvival?.assistantStartedAtMs ?? null,
          model,
        })
      : null;

    // #457 — Hang watchdog. Kills the resident proc (surfacing WHY) if the turn
    // never settles on a `result`.
    const timeout = setTimeout(() => {
      console.warn(`[orchestrator-session] Process timeout (${PROCESS_TIMEOUT_MS}ms) — killing ${session.sessionName}`);
      const minutes = Math.round(PROCESS_TIMEOUT_MS / 60_000);
      onEvent({
        type: 'error',
        error: `Orchestrator hit the ${minutes}-minute watchdog limit and was terminated — a turn running this long has almost certainly hung. Re-send your message to continue.`,
      });
      settleOrchestratorTurn(session, w, null);
      killOrchestratorProc(session, w);
    }, PROCESS_TIMEOUT_MS);

    const turn: OrchestratorActiveTurn = {
      onEvent,
      captureEvent: () => {},
      resolve: resolvePromise,
      reject: rejectPromise,
      timeout,
      abortSignal: options.signal ?? null,
      abortListener: null,
      settled: false,
      toolTracker: createToolCallTracker(),
      turnSessionId: session.claudeSessionId,
      cost: null,
      lastAssistantText: '',
      sawToolUseAfterText: false,
      launchAgentCallCount: 0,
      crashRecord,
      stopCrashTail: null,
    };
    // Narrate-and-exit / false-dispatch telemetry state lives on the turn.
    turn.captureEvent = (e: OrchestratorEvent) => {
      if (e.type === 'text') {
        turn.lastAssistantText += e.text;
        turn.sawToolUseAfterText = false;
      } else if (e.type === 'tool_use') {
        turn.sawToolUseAfterText = true;
        if (e.name === 'cortex_launch_agent' || e.name === 'mcp__cortex__cortex_launch_agent') {
          turn.launchAgentCallCount += 1;
        }
      }
      onEvent(e);
    };
    w.activeTurn = turn;
    if (crashRecord) {
      turn.stopCrashTail = tailJsonlFile({
        filePath: crashRecord.stdoutPath,
        fromOffset: crashOffset,
        alive: () => !!session.proc && isPidAlive(crashRecord.pid) && !turn.settled,
        onLine: (line) => handleClaudeJsonLine(session, w, line),
        onEnd: () => {
          if (!turn.settled) {
            const stderr = existsSync(crashRecord.stderrPath)
              ? (() => {
                  try { return readFileSync(crashRecord.stderrPath, 'utf8').trim(); } catch { return ''; }
                })()
              : '';
            settleOrchestratorTurn(session, w, stderr ? new Error(stderr.slice(0, 500)) : null);
          }
        },
      });
    }

    // #624 — User interrupt. Kills the resident proc (sacrificed for the
    // interrupt; the next turn spawns cold) and settles this turn.
    if (options.signal) {
      if (options.signal.aborted) {
        settleOrchestratorTurn(session, w, null);
        killOrchestratorProc(session, w);
        return;
      }
      turn.abortListener = () => {
        console.log(`[orchestrator-session] User interrupt — killing ${session.sessionName}`);
        settleOrchestratorTurn(session, w, null);
        killOrchestratorProc(session, w);
      };
      options.signal.addEventListener('abort', turn.abortListener, { once: true });
    }

    try {
      proc.stdin.write(payload, 'utf8', (error?: Error | null) => {
        if (error) {
          console.warn(`[orchestrator-session] stdin write failed for ${session.sessionName}:`, error);
          session.status = 'dead';
          settleOrchestratorTurn(session, w, error);
        }
      });
    } catch (error) {
      session.status = 'dead';
      settleOrchestratorTurn(session, w, error instanceof Error ? error : new Error(String(error)));
    }
  });
}
