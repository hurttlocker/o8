/**
 * Codex orchestrator session — sibling to orchestrator-session.ts that spawns
 * `codex exec --json` instead of `claude -p`. Used as the default after the
 * Anthropic SDK pricing change (June 15 2026) so the default install doesn't
 * burn the operator's Agent SDK credit pool.
 *
 * Uses a per-repo sandbox CODEX_HOME with a merged config.toml so Codex can
 * call the same operator + cortex MCP tools as the Claude orchestrator path.
 *
 * COLD by design (unlike the WARMED Claude orchestrator-session.ts, which keeps
 * a resident `claude` process across turns). `codex exec` is a BATCH command —
 * it reads its prompt from argv, ignores stdin, and exits when the turn ends, so
 * there is no resident-process path to warm short of Codex's server/proto mode.
 * Conversation continuity is `codex exec resume <threadId>` — the exec-resume
 * floor. Warming the Codex path is a separate, larger follow-up (wire the Codex
 * app-server / proto interface); NOT built here. In Collide this means the Codex
 * PROPOSER stays cold while the Claude proposer + aggregator warm.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, readFileSync } from 'node:fs';
import type { OrchestratorEvent } from './orchestrator-stream-events';
import type { ToolProfile } from '@/lib/mcp/tool-spine/registry';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import {
  readOrchestratorBackendSessionId,
  writeOrchestratorBackendSessionId,
} from '@/lib/mobile/orchestrator-thread-history';
import { ensureCodexHome } from './codex-orchestrator-config';
export { ensureCodexHome, mergeCodexMcpConfig, stripPluginSections } from './codex-orchestrator-config';
import { parseLocalModel } from '@/lib/codex/local-model';
import { codexCliSupportsUltraEfforts, resolveCodexReasoningEffort } from '@/lib/codex/reasoning-effort';
import { resolveDefaultDispatchModelSync } from '@/lib/operator/defaults';
import { MODEL_IDS } from '@/lib/models';
import { BRAIN_PROMPT_SECTION } from '@/lib/orchestrator/brain-access';
import { buildOrchestratorSystemPrompt } from '@/lib/lane/orchestrator-system-prompt';
import { pathWithNodeRuntime } from '@/lib/util/node-on-path';
import { assertOrchestratorRepoPath } from '@/lib/lane/repo-preflight';
import { handleCodexJsonLine } from './codex-orchestrator-events';
import { codexOrchestrationModeFlags } from './orchestrator-backends/orchestration-mode';
import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';
import { prepareSingleOrchestratorLaunch } from './single-orchestrator-policy';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import {
  ensureRegisteredSession,
  getRegisteredSession,
  normalizeRepoPath,
  normalizeThoughtsThreadId,
  PREEMPT_SETTLE_MS,
  PROCESS_TIMEOUT_MS,
  requestRegisteredSessionReset,
  sessionNameForRepo,
  waitForSessionIdle,
} from './orchestrator-session-core';
import {
  crashSurvivableOrchestratorEnabled,
  createOrchestratorTurnRecord,
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
// ── Types ────────────────────────────────────────────────────────────────────
export interface CodexOrchestratorSession {
  sessionName: string;
  repoPath: string;
  /** UI/history thread id (thoughts-*), when this session belongs to a persisted chat. */
  historyThreadId: string | null;
  /** Codex thread id captured from the `thread.started` event for `exec resume`. */
  threadId: string | null;
  status: 'ready' | 'busy' | 'dead';
  proc: ChildProcess | null;
  createdAt: number;
}
// Mirror of OrchestratorPermissionMode from orchestrator-session.ts.
export type CodexOrchestratorPermissionMode = 'full' | 'plan';
export interface SendToCodexOrchestratorOptions {
  permissionMode?: CodexOrchestratorPermissionMode;
  orchestrationMode?: OrchestratorExecutionMode;
  /**
   * MCP tool profile. `'propose'` (Collide proposer) strips the operator
   * (dispatch) server from this turn's Codex config.toml — the run can read +
   * use cortex but cannot dispatch work. Defaults to `'full'`. See `ToolProfile`.
   */
  toolProfile?: ToolProfile;
  thinkingEffort?: ThinkingEffort;
  model?: string;
  signal?: AbortSignal;
  crashSurvival?: OrchestratorCrashSurvivalMeta;
}
// ── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_CODEX_MODEL = MODEL_IDS.codexDefault;
export const CODEX_FIRST_EVENT_TIMEOUT_MS = 45_000;
// ── Registry ─────────────────────────────────────────────────────────────────
const sessions = new Map<string, CodexOrchestratorSession>();

export function codexOrchestratorSessionName(repoPath: string, threadId?: string | null): string {
  return sessionNameForRepo('cortex-codex-orchestrator', repoPath, threadId);
}

export function getCodexOrchestratorSession(repoPath: string, threadId?: string | null): CodexOrchestratorSession | null {
  return getRegisteredSession(sessions, codexOrchestratorSessionName(repoPath, threadId));
}

export function ensureCodexOrchestratorSession(repoPath: string, threadId?: string | null): CodexOrchestratorSession {
  return ensureRegisteredSession(sessions, {
    repoPath,
    threadId,
    sessionNameFor: codexOrchestratorSessionName,
    logPrefix: '[codex-orchestrator-session]',
    create: (normalizedRepoPath, normalizedThreadId, sessionName) => ({
      sessionName,
      repoPath: normalizedRepoPath,
      historyThreadId: normalizedThreadId,
      threadId: readOrchestratorBackendSessionId(normalizedThreadId, 'codex'),
      status: 'ready',
      proc: null,
      createdAt: Date.now(),
    }),
  });
}

interface CodexOrchestratorRehydrateOptions {
  onReboundEvent?: (record: OrchestratorTurnRecord, event: OrchestratorEvent) => void;
}

export function rehydrateCodexOrchestratorTurns(options: CodexOrchestratorRehydrateOptions = {}): number {
  let count = 0;
  for (const record of listActiveOrchestratorTurns()) {
    if (record.backend !== 'codex') continue;
    const sessionName = record.sessionName || codexOrchestratorSessionName(record.repoPath, record.threadId);
    let session = sessions.get(sessionName);
    if (!session) {
      session = {
        sessionName,
        repoPath: normalizeRepoPath(record.repoPath),
        historyThreadId: normalizeThoughtsThreadId(record.threadId),
        threadId: readOrchestratorBackendSessionId(normalizeThoughtsThreadId(record.threadId), 'codex'),
        status: 'busy',
        proc: null,
        createdAt: record.startedAt,
      };
      sessions.set(sessionName, session);
    } else {
      session.status = 'busy';
    }
    const lineState = { cost: null as number | null, threadId: session.threadId };
    const isLocalModel = typeof record.model === 'string' && !!parseLocalModel(record.model);
    const emit = (event: OrchestratorEvent) => {
      options.onReboundEvent?.(record, event);
    };
    const handleLine = (line: string) => {
      handleCodexJsonLine(line, lineState, emit, { isLocalModel });
      if (lineState.threadId) session!.threadId = lineState.threadId;
    };
    const finishRecord = () => {
      if (lineState.threadId) session!.threadId = lineState.threadId;
      session!.status = 'ready';
      emit({ type: 'done', sessionId: lineState.threadId, cost: lineState.cost });
      finishOrchestratorTurn(record, 'completed');
    };
    const replay = readJsonlLines(record.stdoutPath, record.stdoutOffset ?? 0).lines;
    for (const line of replay) {
      handleLine(line);
    }
    if (!isRehydratedTurnAlive(record, PROCESS_TIMEOUT_MS)) {
      finishRecord();
      count += 1;
      continue;
    }
    tailJsonlFile({
      filePath: record.stdoutPath,
      fromOffset: fileSize(record.stdoutPath),
      alive: () => isRehydratedTurnAlive(record, PROCESS_TIMEOUT_MS),
      onLine: handleLine,
      onEnd: () => {
        finishRecord();
      },
    });
    count += 1;
  }
  return count;
}

// ── Permission mode mapping ──────────────────────────────────────────────────

function sandboxFlagsForMode(mode: CodexOrchestratorPermissionMode): string[] {
  // These flags go to both `codex exec` (first turn) and `codex exec resume`
  // (every turn after). `resume` rejects the `-s` short flag — passing it broke
  // every multi-turn conversation — so the read-only sandbox is set via a `-c`
  // config override, which both subcommands honor.
  if (mode === 'plan') {
    // Read-only sandbox — codex can read repo state and call MCP read methods
    // but cannot edit files or run side-effecting shell commands.
    return ['-c', 'sandbox_mode=read-only'];
  }
  // 'full' — autonomous mode for auto-review + intake.
  // `--dangerously-bypass-approvals-and-sandbox` bypasses approvals + the
  // sandbox and is accepted by `codex exec resume` (unlike `-s`).
  return ['--dangerously-bypass-approvals-and-sandbox'];
}

function reasoningEffortFromThinkingEffort(effort: ThinkingEffort | undefined, model?: string): string {
  if (!effort || effort === 'adaptive') return 'xhigh';
  // GPT-5.6 effort tiers: low, medium, high, xhigh, max, ultra. The `max`/`ultra`
  // tiers are honored ONLY on gpt-5.6-sol; every other model (terra, luna,
  // gpt-5.5, locals) clamps to xhigh — see resolveCodexReasoningEffort.
  return resolveCodexReasoningEffort(effort, model);
}

/**
 * Resolve the orchestrator's Codex model. An explicit per-turn model always
 * wins. Otherwise: if the operator's default dispatch model is a LOCAL model
 * (`ollama:` / `lmstudio:`), the orchestrator runs on it too — so a zero-cloud-
 * key dev's chat surface works end-to-end on their own machine. A *cloud*
 * dispatch model does NOT change the orchestrator default (workers and the
 * orchestrator are separate concerns on the cloud path), so the configured
 * Codex flagship default is preserved exactly.
 */
export function resolveOrchestratorModelSync(explicit?: string): string {
  const trimmed = explicit?.trim();
  // Cross-backend bleed guard (live-hit 2026-07-05): the chat surface passes
  // the UI-selected CLAUDE model (e.g. claude-opus-4-8) as the explicit model
  // when the operator flips orchestratorBackend to codex — codex exec can't
  // run an Anthropic model id and the turn hangs forever with nothing
  // streamed. A claude-* explicit model is a backend mismatch, not a choice:
  // fall through to the codex default instead of trusting it.
  if (trimmed && !/^claude/i.test(trimmed)) return trimmed;
  const dispatch = resolveDefaultDispatchModelSync().trim();
  if (dispatch && parseLocalModel(dispatch)) return dispatch;
  return DEFAULT_CODEX_MODEL;
}

/**
 * Build the model `-c`/flag pairs for `codex exec`. A local model expands to the
 * `--oss --local-provider … --model` form (no reasoning-effort tier — local
 * models don't have one). A cloud model keeps the historical `-c model=` +
 * `-c model_reasoning_effort=` pair verbatim, so the default path is unchanged.
 * Exported for the unit test that locks the cloud-path invariant.
 */
export function codexOrchestratorModelFlags(model: string, reasoningEffort: string): string[] {
  const local = parseLocalModel(model);
  if (local) {
    return ['--oss', '--local-provider', local.provider, '--model', local.model];
  }
  return ['-c', `model=${model}`, '-c', `model_reasoning_effort=${reasoningEffort}`];
}

const CODEX_BRAIN_FIRST_SECTION = [
  '## ENGINEERING BRAIN — USE THIS FIRST',
  BRAIN_PROMPT_SECTION,
  'Codex orchestrator rule: on every turn, if you need repo conventions, history, ownership, prior fixes, directives, or cross-repo context, ask the Engineering Brain first via the `cortex_ask` MCP tool (or `o8 ask` from shell) before grepping or re-reading broad files. One focused Brain question is the default context-gathering step; use direct file reads after the Brain points you at current source or when exact code is needed.',
].join('\n\n');

export function buildCodexOrchestratorPrompt(repoPath: string, message: string): string {
  return [
    buildOrchestratorSystemPrompt(repoPath),
    CODEX_BRAIN_FIRST_SECTION,
    '## USER MESSAGE',
    message,
  ].join('\n\n');
}

// ── Event mapping (codex JSON → OrchestratorEvent) ───────────────────────────

// ── Send message ─────────────────────────────────────────────────────────────

function isMissingCodexRolloutResumeError(error: string): boolean {
  const normalized = error.toLowerCase();
  if (!normalized.includes('thread/resume')) return false;
  return normalized.includes('no rollout found for thread id')
    || (normalized.includes('failed to resolve rollout path') && normalized.includes('file does not exist'));
}

export async function sendToCodexOrchestrator(
  session: CodexOrchestratorSession,
  message: string,
  onEvent: (event: OrchestratorEvent) => void,
  options: SendToCodexOrchestratorOptions = {},
): Promise<void> {
  if (!session.threadId) {
    return sendToCodexOrchestratorAttempt(session, message, onEvent, options);
  }

  const deferredTerminalEvents: OrchestratorEvent[] = [];
  let streamed = false;
  await sendToCodexOrchestratorAttempt(session, message, (event) => {
    if (event.type === 'error' || event.type === 'done') deferredTerminalEvents.push(event);
    else {
      streamed = true;
      onEvent(event);
    }
  }, options);

  const terminalError = deferredTerminalEvents.find((event) => event.type === 'error');
  const missingRollout = terminalError?.type === 'error'
    && isMissingCodexRolloutResumeError(terminalError.error);
  if (!streamed && missingRollout && !options.signal?.aborted) {
    console.warn(`[codex-orchestrator-session] Saved Codex thread is gone; retrying ${session.sessionName} fresh`);
    session.threadId = null;
    session.status = 'ready';
    writeOrchestratorBackendSessionId(session.historyThreadId, 'codex', null);
    return sendToCodexOrchestratorAttempt(session, message, onEvent, options);
  }

  for (const event of deferredTerminalEvents) onEvent(event);
}

async function sendToCodexOrchestratorAttempt(
  session: CodexOrchestratorSession,
  message: string,
  onEvent: (event: OrchestratorEvent) => void,
  options: SendToCodexOrchestratorOptions = {},
): Promise<void> {
  // Fable is Claude-only — its native-tool lockout + BYO-key path live in the
  // Claude REPL (orchestrator-session.ts). The registry routes 'fable' to
  // fableBackend, so a 'fable' profile reaching a Codex orchestrator is a
  // mis-wire; fail closed rather than silently running Fable's surface on Codex.
  if (options.toolProfile === 'fable') {
    throw new Error("Codex orchestrator does not support the 'fable' tool profile (Fable is Claude-only).");
  }
  const settleBeforeSpawnIfAborted = (): boolean => {
    if (!options.signal?.aborted) return false;
    session.status = 'ready';
    session.proc = null;
    onEvent({ type: 'done', sessionId: session.threadId, cost: null });
    return true;
  };
  if (settleBeforeSpawnIfAborted()) return;
  const permissionMode: CodexOrchestratorPermissionMode = options.permissionMode ?? 'full';
  const model = resolveOrchestratorModelSync(options.model);
  const isLocalModel = !!parseLocalModel(model);
  let reasoningEffort = reasoningEffortFromThinkingEffort(options.thinkingEffort, model);

  // Steer-Now / queue preempt: the ws-server aborts the prior turn's
  // controller before calling sendTurn, so a still-'busy' session here is a
  // just-interrupted subprocess mid-teardown. Wait for it to close rather than
  // dropping the steered message. See orchestrator-session.ts for the full why.
  if (session.status === 'busy') {
    await waitForSessionIdle(session, PREEMPT_SETTLE_MS);
  }
  if (settleBeforeSpawnIfAborted()) return;

  // A SIGTERM'd turn exits non-zero → 'dead', so the settle wait above commonly
  // lands here; auto-recover into a fresh turn.
  if (session.status === 'dead') {
    console.log(`[codex-orchestrator-session] Auto-recovering dead session ${session.sessionName}`);
    session.status = 'ready';
    session.threadId = null;
    session.proc = null;
  }
  // Still busy after the settle window — genuinely concurrent / hung. Reject.
  // The synchronous `session.status = 'busy'` claim below means a second waiter
  // that lost the race re-enters here and rejects instead of double-spawning.
  if (session.status === 'busy') {
    throw new Error('Codex orchestrator session is busy');
  }

  session.status = 'busy';
  // #1551 — preflight the repo path before ANY spawn work. The default
  // backend had no preflight at all: a missing folder surfaced as
  // "spawn codex ENOENT" (naming the healthy binary), and a non-git folder
  // let codex boot and fail into a confusing tool-side error mid-turn.
  try {
    assertOrchestratorRepoPath(session.repoPath);
  } catch (err) {
    session.status = 'dead';
    onEvent({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    onEvent({ type: 'done', sessionId: session.threadId, cost: null });
    return;
  }
  let codexHome: string;
  try {
    // A 'propose' turn gets the operator-stripped (read-only proposer) config —
    // Collide's dispatch lockout.
    codexHome = ensureCodexHome(session.repoPath, options.toolProfile ?? 'full');
  } catch (err) {
    session.status = 'dead';
    const note = `Failed to prepare Codex MCP config: ${err instanceof Error ? err.message : String(err)}`;
    onEvent({ type: 'error', error: note });
    onEvent({ type: 'done', sessionId: session.threadId, cost: null });
    return;
  }
  if (settleBeforeSpawnIfAborted()) return;

  const { resolveCli, CliNotFoundError } = await import('@/lib/runtimes/shared/cli-resolver');
  if (settleBeforeSpawnIfAborted()) return;
  let codexBin: string;
  try {
    const resolved = await resolveCli({
      runtimeId: 'codex',
      binaryName: 'codex',
      envOverride: 'O8_CODEX_BIN',
      extraEnvOverrides: ['CODEX_HOME'],
    });
    codexBin = resolved.path;
    // The model-gated clamp (sol may use max/ultra) is not enough — the
    // INSTALLED CLI must also understand the tier. An older codex refuses to
    // load config mentioning `max` and exits 1 before the first token.
    if ((reasoningEffort === 'max' || reasoningEffort === 'ultra') && !codexCliSupportsUltraEfforts(resolved.version)) {
      console.warn(`[codex-orchestrator] installed codex ${resolved.version ?? '(unknown version)'} predates '${reasoningEffort}' — clamping to xhigh`);
      reasoningEffort = 'xhigh';
    }
  } catch (err) {
    if (settleBeforeSpawnIfAborted()) return;
    session.status = 'dead';
    const note = err instanceof CliNotFoundError
      ? `Codex binary not found: ${err.message}`
      : `Failed to resolve Codex binary: ${err instanceof Error ? err.message : String(err)}`;
    onEvent({ type: 'error', error: note });
    onEvent({ type: 'done', sessionId: session.threadId, cost: null });
    return;
  }
  if (settleBeforeSpawnIfAborted()) return;

  // First-turn launch vs resume.
  const isResume = Boolean(session.threadId);
  const args: string[] = isResume
    ? [
        'exec',
        'resume',
        session.threadId!,
        '--json',
        ...(options.orchestrationMode === 'single' ? [] : sandboxFlagsForMode(permissionMode)),
        ...codexOrchestrationModeFlags(options.orchestrationMode),
        ...codexOrchestratorModelFlags(model, reasoningEffort),
        // Disable the hosted image_generation tool (defaults to nonexistent
        // gpt-image-2 in Codex CLI 0.130.0 → 400s every turn at spawn).
        '-c',
        'tools.image_generation=false',
        '--',
        message,
      ]
    : [
        'exec',
        '--json',
        ...(options.orchestrationMode === 'single' ? [] : sandboxFlagsForMode(permissionMode)),
        ...codexOrchestrationModeFlags(options.orchestrationMode),
        ...codexOrchestratorModelFlags(model, reasoningEffort),
        '-c',
        'tools.image_generation=false',
        '-C',
        session.repoPath,
        '--',
        message,
      ];

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: pathWithNodeRuntime(),
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    O8_MANAGED_SESSION: '1',
    CODEX_HOME: codexHome,
  };
  let spawnBinary = codexBin;
  let spawnArgs = args;
  let spawnEnv = baseEnv;
  let cleanupSingleLaunch = () => {};
  if (options.orchestrationMode === 'single') {
    try {
      const prepared = await prepareSingleOrchestratorLaunch({
        repoPath: session.repoPath, codexHome, binary: codexBin, args, env: baseEnv,
      });
      spawnBinary = prepared.binary;
      spawnArgs = prepared.args;
      spawnEnv = prepared.env;
      cleanupSingleLaunch = prepared.cleanup;
    } catch (err) {
      session.status = 'dead';
      onEvent({ type: 'error', error: `Single mode unavailable: ${err instanceof Error ? err.message : String(err)}` });
      onEvent({ type: 'done', sessionId: session.threadId, cost: null });
      return;
    }
  }

  return new Promise<void>((promiseResolve) => {
    let crashRecord: OrchestratorTurnRecord | null = null;
    let stdoutFd: number | null = null;
    let stderrFd: number | null = null;
    const crashEnabled = crashSurvivableOrchestratorEnabled();
    if (crashEnabled) {
      crashRecord = createOrchestratorTurnRecord({
        backend: 'codex',
        sessionName: session.sessionName,
        repoPath: session.repoPath,
        threadId: options.crashSurvival?.threadId ?? session.historyThreadId,
        pid: 0,
        assistantMessageId: options.crashSurvival?.assistantMessageId ?? null,
        assistantStartedAtMs: options.crashSurvival?.assistantStartedAtMs ?? null,
        model,
      });
      stdoutFd = openAppendFile(crashRecord.stdoutPath);
      stderrFd = openAppendFile(crashRecord.stderrPath);
    }
    let proc: ChildProcess;
    const singleProcessGroup = options.orchestrationMode === 'single';
    try {
      const launch = cliInvocation(spawnBinary, spawnArgs);
      proc = spawn(launch.command, launch.args, { windowsHide: true,
        cwd: session.repoPath,
        env: spawnEnv,
        detached: crashEnabled || singleProcessGroup,
        stdio: crashEnabled && stdoutFd !== null && stderrFd !== null
          ? ['ignore', stdoutFd, stderrFd]
          : ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      if (stdoutFd !== null) closeSync(stdoutFd);
      if (stderrFd !== null) closeSync(stderrFd);
      finishOrchestratorTurn(crashRecord, 'failed');
      cleanupSingleLaunch();
      session.status = 'dead';
      const note = err instanceof Error ? err.message : String(err);
      onEvent({ type: 'error', error: note });
      onEvent({ type: 'done', sessionId: session.threadId, cost: null });
      promiseResolve();
      return;
    }
    if (stdoutFd !== null) closeSync(stdoutFd);
    if (stderrFd !== null) closeSync(stderrFd);
    if (crashEnabled) proc.unref();
    if (crashRecord) {
      crashRecord = updateOrchestratorTurnPid(crashRecord, proc.pid ?? 0);
    }
    session.proc = proc;

    const userAbortSignal = options.signal;
    let userAbortListener: (() => void) | null = null;
    const detachUserAbortListener = () => {
      if (userAbortSignal && userAbortListener) {
        userAbortSignal.removeEventListener('abort', userAbortListener);
        userAbortListener = null;
      }
    };

    let lineBuffer = '';
    const lineState = { cost: null as number | null, threadId: session.threadId };
    let stopCrashTail: (() => void) | null = null;
    let crashTailOffset = 0;
    let settled = false;
    let processTimeout: ReturnType<typeof setTimeout> | null = null;
    let firstEventTimeout: ReturnType<typeof setTimeout> | null = null;
    let sawFirstEvent = false;
    const handleCodexLine = (line: string) => {
      const parsed = handleCodexJsonLine(line, lineState, onEvent, { isLocalModel });
      if (parsed) {
        sawFirstEvent = true;
        if (firstEventTimeout) {
          clearTimeout(firstEventTimeout);
          firstEventTimeout = null;
        }
      }
    };

    const drainCrashOutput = () => {
      stopCrashTail?.();
      stopCrashTail = null;
      if (!crashRecord) return;
      const remainder = readJsonlLines(crashRecord.stdoutPath, crashTailOffset);
      crashTailOffset = remainder.offset;
      for (const line of remainder.lines) handleCodexLine(line);
    };

    const settle = (status: 'ready' | 'dead', error?: string, drain = false) => {
      if (settled) return;
      settled = true;
      if (processTimeout) clearTimeout(processTimeout);
      if (firstEventTimeout) clearTimeout(firstEventTimeout);
      if (drain) drainCrashOutput();
      else stopCrashTail?.();
      finishOrchestratorTurn(crashRecord, error ? 'failed' : 'completed');
      if (proc.exitCode == null && proc.signalCode == null) proc.once('close', cleanupSingleLaunch);
      else cleanupSingleLaunch();
      detachUserAbortListener();
      session.proc = null;
      if (lineState.threadId) session.threadId = lineState.threadId;
      session.status = status;
      if (error) onEvent({ type: 'error', error });
      onEvent({ type: 'done', sessionId: lineState.threadId, cost: lineState.cost });
      promiseResolve();
    };

    const terminate = (escalateAfterMs: number) => {
      const kill = (signal: NodeJS.Signals) => {
        if (singleProcessGroup && proc.pid) {
          try { process.kill(-proc.pid, signal); return; } catch {
            if (proc.exitCode != null || proc.signalCode != null) return;
          }
        }
        if (proc.exitCode != null || proc.signalCode != null) return;
        proc.kill(signal);
      };
      kill('SIGTERM');
      const escalation = setTimeout(() => {
        kill('SIGKILL');
      }, escalateAfterMs);
      escalation.unref?.();
    };

    if (crashRecord) {
      stopCrashTail = tailJsonlFile({
        filePath: crashRecord.stdoutPath,
        // The file was created empty immediately before spawn. Starting at its
        // post-spawn size can skip a fast child's first event.
        fromOffset: 0,
        alive: () => isPidAlive(crashRecord?.pid) && session.proc === proc,
        onLine: handleCodexLine,
        onOffset: (offset) => { crashTailOffset = offset; },
        onEnd: () => {},
      });
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString('utf-8');
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        handleCodexLine(line);
      }
    });

    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    proc.on('error', (err) => {
      settle('dead', err.message, true);
    });

    proc.on('close', (code) => {
      if (settled) return;
      if (lineBuffer.trim()) {
        handleCodexLine(lineBuffer);
      }
      const crashStderr = crashRecord && code !== 0
        ? readFileSync(crashRecord.stderrPath, 'utf8')
        : '';
      const error = code === 0
        ? undefined
        : (stderr || crashStderr).trim().slice(0, 500) || `codex exited with code ${code}`;
      settle(code === 0 ? 'ready' : 'dead', error, true);
    });

    if (!sawFirstEvent) {
      firstEventTimeout = setTimeout(() => {
        const note = 'Codex produced no output for 45s — the turn was aborted; re-send to retry';
        console.warn(`[codex-orchestrator-session] ${note} (${session.sessionName})`);
        settle('dead', note);
        terminate(2_000);
      }, CODEX_FIRST_EVENT_TIMEOUT_MS);
    }

    processTimeout = setTimeout(() => {
      const minutes = Math.round(PROCESS_TIMEOUT_MS / 60_000);
      const note = `Orchestrator hit the ${minutes}-minute watchdog limit and was terminated — re-send your message to continue.`;
      console.warn(`[codex-orchestrator-session] ${note} (${session.sessionName})`);
      settle('dead', note);
      terminate(5_000);
    }, PROCESS_TIMEOUT_MS);

    userAbortListener = () => {
      console.log(`[codex-orchestrator-session] User interrupt — killing ${session.sessionName}`);
      settle('dead');
      terminate(2_000);
    };
    if (userAbortSignal?.aborted) userAbortListener();
    else userAbortSignal?.addEventListener('abort', userAbortListener, { once: true });
  });
}

/**
 * Reset the codex orchestrator session for a repo — forces the next call to
 * start a fresh codex thread instead of resuming. Used by the conversational
 * reload paths so a new MCP registration takes effect immediately.
 */
export function requestCodexOrchestratorSessionReset(repoPath: string, threadId?: string | null): {
  repoPath: string;
  sessionName: string;
  threadId: string | null;
} {
  return requestRegisteredSessionReset(sessions, {
    repoPath,
    threadId,
    sessionNameFor: codexOrchestratorSessionName,
    resetExisting: (session) => {
      session.threadId = null;
    },
    resetPersistedThread: (normalizedThreadId) => writeOrchestratorBackendSessionId(normalizedThreadId, 'codex', null),
  });
}
