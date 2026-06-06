/**
 * Orchestrator session — runs Claude Code via the interactive stream-json
 * REPL path so turns bill the user's **Claude Code MAX subscription pool**
 * (the same pool `claude` in Terminal eats from), NOT the Agent SDK pool
 * that's gated by Anthropic's June-15 cap. Spawn pattern:
 *
 *   claude --input-format stream-json --output-format stream-json \
 *          --verbose --include-partial-messages \
 *          [--permission-mode plan | --dangerously-skip-permissions] \
 *          --mcp-config <path> --model <name> [--resume <id>]
 *
 * Each turn writes a single JSON message to the process's stdin and then
 * closes stdin to signal completion; claude streams events to stdout and
 * exits cleanly when the turn is done. Conversation context persists via
 * `--resume SESSION_ID` on follow-up messages.
 *
 * Subscription-billed. NO `-p` flag — that's the Agent SDK path which is
 * capped. See [[claude_code_interactive_repl_pivot]] +
 * [[session_may14_sdk_pricing_pivot]] memories for the why.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listActiveLanesWithSessions } from '@/lib/lane/registry';
import { assertNoPrintFlag } from '@/lib/claude-code/assert-no-print-flag';
import {
  readOrchestratorBackendSessionId,
  writeOrchestratorBackendSessionId,
} from '@/lib/mobile/orchestrator-thread-history';
import {
  createToolCallTracker,
  processStreamEvent,
  type OrchestratorEvent,
} from '@/lib/lane/orchestrator-stream-events';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { getRuntime, type RuntimeSession } from '@/lib/runtimes';
import { getMcpServersConfig } from './orchestrator-mcp-config';

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

const CLAUDE_BIN = process.env.CLAUDE_BIN || join(homedir(), '.local', 'bin', 'claude');
const ORCHESTRATOR_STATE_DIR = join(
  process.env.CORTEX_IDE_DATA_DIR || join(homedir(), '.o8'),
  'orchestrator',
);

const MCP_CONFIG_DIR = join(homedir(), '.o8', 'mcp');
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
// fits comfortably. If a turn legitimately needs more, the operator can
// re-prompt with a tighter brief that pre-supplies the file pointers.
const PROCESS_TIMEOUT_MS = 1_800_000;

/**
 * Steer-Now / preempt settle window. A follow-up send fired while a turn is
 * still in flight (Steer-Now, or the steer-queue auto-fire) arrives ~immediately
 * after the interrupt SIGTERMs the prior subprocess — but `session.status` only
 * leaves 'busy' when `proc.on('close')` fires (~1-2s later, SIGKILL fallback at
 * 2s). Waiting that window out lets the dying turn settle so the new message is
 * accepted instead of being dropped with a hard "busy" rejection.
 */
const PREEMPT_SETTLE_MS = 4_000;

/** Poll until the session leaves 'busy' (a turn closed) or the window elapses. */
async function waitForOrchestratorIdle(session: OrchestratorSession, timeoutMs: number): Promise<void> {
  if (session.status !== 'busy') return;
  const deadline = Date.now() + timeoutMs;
  while (session.status === 'busy' && Date.now() < deadline) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 50));
  }
}

let startupRehydrationPromise: Promise<void> | null = null;
let startupRehydrationComplete = false;

function normalizeRepoPath(repoPath: string): string {
  return resolve(repoPath).replace(/\/+$/, '');
}

function ensureOrchestratorStateDir(): void {
  if (!existsSync(ORCHESTRATOR_STATE_DIR)) {
    mkdirSync(ORCHESTRATOR_STATE_DIR, { recursive: true });
  }
}

function normalizeThreadId(threadId?: string | null): string | null {
  const trimmed = threadId?.trim() ?? '';
  return trimmed.startsWith('thoughts-') ? trimmed : null;
}

function threadKey(threadId?: string | null): string | null {
  const normalized = normalizeThreadId(threadId);
  return normalized ? normalized.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) : null;
}

function orchestratorResetSignalPath(repoPath: string, threadId?: string | null): string {
  const threadSuffix = threadKey(threadId);
  return join(
    ORCHESTRATOR_STATE_DIR,
    `session-reset-${repoHash(normalizeRepoPath(repoPath))}${threadSuffix ? `-${threadSuffix}` : ''}.json`,
  );
}

function writeOrchestratorResetSignal(repoPath: string, threadId?: string | null): void {
  ensureOrchestratorStateDir();
  writeFileSync(
    orchestratorResetSignalPath(repoPath, threadId),
    `${JSON.stringify({ repoPath: normalizeRepoPath(repoPath), threadId: normalizeThreadId(threadId), requestedAt: Date.now() })}\n`,
    'utf8',
  );
}

function consumeOrchestratorResetSignal(repoPath: string, threadId?: string | null): boolean {
  const signalPath = orchestratorResetSignalPath(repoPath, threadId);
  if (!existsSync(signalPath)) {
    return false;
  }

  try {
    rmSync(signalPath, { force: true });
    return true;
  } catch {
    return false;
  }
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

export async function rehydrateOrchestratorSessions(): Promise<void> {
  if (startupRehydrationComplete) {
    return;
  }
  if (startupRehydrationPromise) {
    return startupRehydrationPromise;
  }

  startupRehydrationPromise = (async () => {
    const activeLanes = listActiveLanesWithSessions();
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
      `${LOG_PREFIX} Startup scan checked ${activeLanes.length} active lane${activeLanes.length === 1 ? '' : 's'} and restored ${rehydratedCount} orchestrator session${rehydratedCount === 1 ? '' : 's'}`,
    );
    startupRehydrationComplete = true;
  })()
    .finally(() => {
      startupRehydrationPromise = null;
    });

  return startupRehydrationPromise;
}

/** Generate a temporary MCP config file for orchestrator context sources. */
function ensureMcpConfig(repoPath: string): string {
  if (!existsSync(MCP_CONFIG_DIR)) mkdirSync(MCP_CONFIG_DIR, { recursive: true });

  const configPath = join(MCP_CONFIG_DIR, `orchestrator-${repoHash(repoPath)}.json`);
  const config = {
    mcpServers: getMcpServersConfig(repoPath),
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`[orchestrator-session] MCP config written to ${configPath}`);
  return configPath;
}

/**
 * Appended to Claude Code's default system prompt on the first message only.
 *
 * Prompt body lives in `orchestrator.md` next to this file — edit the md and
 * the next orchestrator turn picks it up immediately. The file is read on
 * every call so there's no cache to bust. Placeholders:
 *
 *   {{REPO_NAME}} — primary repo name
 *   {{REPO_PATH}} — primary repo absolute path
 *   {{REPO_LIST}} — bullet list of registered repos for fleet awareness
 *
 * In dev the file resolves via `import.meta.url` to `src/lib/lane/orchestrator.md`.
 * In the Tauri-bundled prod build the md file is copied to `out/server/orchestrator.md`
 * by `scripts/tauri-export.mjs` so the same resolution strategy works.
 */
const PROMPT_FILE_NAME = 'orchestrator.md';
const FALLBACK_PROMPT = [
  'You are the orchestrator for o8. The markdown prompt file could not be loaded.',
  'Primary repo: "{{REPO_NAME}}" at {{REPO_PATH}}.',
  'Work carefully, use cortex_* MCP tools for fleet awareness, and always end your',
  'review turns with a VERDICT block so the user has an actionable summary.',
].join('\n');

function resolvePromptFilePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, PROMPT_FILE_NAME);
}

function buildOrchestratorSystemPrompt(repoPath: string): string {
  const repoName = repoPath.split('/').filter(Boolean).pop() ?? repoPath;

  // Load all registered repos for fleet awareness
  let allRepos: Array<{ name: string; localPath: string }> = [];
  try {
    const reposFile = join(homedir(), '.o8', 'repos.json');
    if (existsSync(reposFile)) {
      const parsed = JSON.parse(readFileSync(reposFile, 'utf-8'));
      allRepos = (parsed.repos ?? []).map((r: { name?: string; localPath: string }) => ({
        name: r.name ?? r.localPath.split('/').filter(Boolean).pop() ?? r.localPath,
        localPath: r.localPath,
      }));
    }
  } catch { /* best effort */ }

  const repoList = allRepos.length > 0
    ? allRepos.map((r) => `  - ${r.name} → ${r.localPath}`).join('\n')
    : `  - ${repoName} → ${repoPath}`;

  let template: string;
  try {
    template = readFileSync(resolvePromptFilePath(), 'utf-8');
  } catch (err) {
    console.warn(
      `[orchestrator-session] Failed to load ${PROMPT_FILE_NAME}: ${(err as Error).message}. Using minimal fallback prompt.`,
    );
    template = FALLBACK_PROMPT;
  }

  return template
    .replaceAll('{{REPO_NAME}}', repoName)
    .replaceAll('{{REPO_PATH}}', repoPath)
    .replaceAll('{{REPO_LIST}}', repoList);
}

// ── Registry ──

const sessions = new Map<string, OrchestratorSession>();

function repoHash(repoPath: string): string {
  return createHash('sha256').update(repoPath).digest('hex').slice(0, 8);
}

export function orchestratorSessionName(repoPath: string, threadId?: string | null): string {
  const threadSuffix = threadKey(threadId);
  return `cortex-orchestrator-${repoHash(normalizeRepoPath(repoPath))}${threadSuffix ? `-${threadSuffix}` : ''}`;
}

export function getOrchestratorSession(repoPath: string, threadId?: string | null): OrchestratorSession | null {
  void rehydrateOrchestratorSessions().catch(() => {
    // Startup rehydration is best-effort; callers can still create a fresh session.
  });
  return sessions.get(orchestratorSessionName(repoPath, threadId)) ?? null;
}

export function requestOrchestratorSessionReset(repoPath: string, threadId?: string | null): { repoPath: string; sessionName: string; threadId: string | null } {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const normalizedThreadId = normalizeThreadId(threadId);
  const sessionName = orchestratorSessionName(normalizedRepoPath, normalizedThreadId);

  writeOrchestratorResetSignal(normalizedRepoPath, normalizedThreadId);

  const session = sessions.get(sessionName);
  if (session) {
    session.claudeSessionId = null;
  }
  if (normalizedThreadId) {
    writeOrchestratorBackendSessionId(normalizedThreadId, 'claude', null);
  }

  return { repoPath: normalizedRepoPath, sessionName, threadId: normalizedThreadId };
}

/**
 * Request a graceful orchestrator reload. Unlike `requestOrchestratorSessionReset`,
 * this PRESERVES the `claudeSessionId` so the next user turn resumes the
 * existing transcript via `--resume`. The in-flight MCP config is rewritten
 * on every turn in `ensureMcpConfig()`, so simply letting the next turn spawn
 * is enough to pick up a newly-registered external MCP server. Used by the
 * conversational `cortex.register_mcp` flow.
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
  const normalizedThreadId = normalizeThreadId(threadId);
  const sessionName = orchestratorSessionName(normalizedRepoPath, normalizedThreadId);
  const session = sessions.get(sessionName);
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

  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const normalizedThreadId = normalizeThreadId(threadId);
  const sessionName = orchestratorSessionName(normalizedRepoPath, normalizedThreadId);
  const existing = sessions.get(sessionName);

  if (existing && existing.status !== 'dead') {
    return existing;
  }

  const session: OrchestratorSession = {
    sessionName,
    repoPath: normalizedRepoPath,
    threadId: normalizedThreadId,
    claudeSessionId: readOrchestratorBackendSessionId(normalizedThreadId, 'claude'),
    status: 'ready',
    proc: null,
    createdAt: Date.now(),
  };
  sessions.set(sessionName, session);
  console.log(`[orchestrator-session] Created ${sessionName} for ${normalizedRepoPath}${normalizedThreadId ? ` (${normalizedThreadId})` : ''}`);
  return session;
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
export const DEFAULT_ORCHESTRATOR_MODEL = 'claude-opus-4-8';

export interface SendToOrchestratorOptions {
  permissionMode?: OrchestratorPermissionMode;
  thinkingEffort?: ThinkingEffort;
  model?: string;
  /**
   * #624 — Abort signal for user-initiated interrupt. When aborted mid-stream,
   * the in-flight claude CLI subprocess is terminated with SIGTERM so the turn
   * ends within 1-2s. Partial transcript output that already fired via onEvent
   * is preserved — only NEW output is stopped.
   */
  signal?: AbortSignal;
}

/**
 * Sends a message to the orchestrator. Spawns a claude process that outputs
 * stream-json. Calls `onEvent` for each parsed event. Returns when the
 * process exits.
 */
export async function sendToOrchestrator(
  session: OrchestratorSession,
  message: string,
  onEvent: (event: OrchestratorEvent) => void,
  options: SendToOrchestratorOptions = {},
): Promise<void> {
  const permissionMode: OrchestratorPermissionMode = options.permissionMode ?? 'full';
  const thinkingEffort = options.thinkingEffort;
  const model = options.model?.trim() || DEFAULT_ORCHESTRATOR_MODEL;

  // Steer-Now / queue preempt: the ws-server aborts the prior turn's
  // controller before calling sendTurn, so a still-'busy' session here means a
  // just-interrupted subprocess that's mid-teardown. Wait for it to close
  // rather than rejecting the steered message outright.
  if (session.status === 'busy') {
    await waitForOrchestratorIdle(session, PREEMPT_SETTLE_MS);
  }

  // #457 — Auto-recover dead sessions by creating a fresh one. A SIGTERM'd turn
  // exits non-zero → 'dead', so the settle wait above commonly lands here.
  if (session.status === 'dead') {
    console.log(`[orchestrator-session] Auto-recovering dead session ${session.sessionName}`);
    session.status = 'ready';
    session.claudeSessionId = null;
    session.proc = null;
  }
  // Still busy after the settle window — a genuinely concurrent turn that was
  // never interrupted, or a hung proc. Reject as before. The `session.status =
  // 'busy'` claim below is synchronous (no await before the spawn), so a second
  // waiter that lost the race re-enters here and rejects instead of double-spawning.
  if (session.status === 'busy') {
    throw new Error('Orchestrator session is busy');
  }

  if (consumeOrchestratorResetSignal(session.repoPath, session.threadId)) {
    session.claudeSessionId = null;
  }

  session.status = 'busy';

  // Generate MCP config so Claude Code can use Cortex tools
  const mcpConfigPath = ensureMcpConfig(session.repoPath);

  // Map manual thinking effort to Claude Code CLI's --effort flag. Adaptive
  // is represented by omitting the flag entirely so Claude Code self-regulates.
  const effortMap = {
    low: 'low',
    medium: 'medium',
    high: 'high',
    max: 'max',
    xhigh: 'xhigh',
  } as const;

  // Interactive REPL flags — `--input-format stream-json` puts claude into
  // the subscription-billed REPL path (no `-p`). We pass the actual message
  // via stdin (JSON-encoded) below, then close stdin to signal turn end.
  const args: string[] = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    ...(permissionMode === 'plan'
      ? ['--permission-mode', 'plan']
      : ['--dangerously-skip-permissions']),
    '--verbose',
    '--mcp-config', mcpConfigPath,
    '--model', model,
  ];
  if (thinkingEffort && thinkingEffort !== 'adaptive') {
    args.push('--effort', effortMap[thinkingEffort]);
  }

  // Resume existing conversation if we have a session ID
  if (session.claudeSessionId) {
    args.push('--resume', session.claudeSessionId);
  } else {
    // First message — inject orchestrator identity and context
    args.push('--append-system-prompt', buildOrchestratorSystemPrompt(session.repoPath));
  }

  // #1066 billing guard — the orchestrator REPL must stay subscription-billed.
  assertNoPrintFlag(args, 'Orchestrator REPL session');

  return new Promise<void>((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, {
      cwd: session.repoPath,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        O8_MANAGED_SESSION: '1',
      },
      // Interactive REPL mode — stdin must be writable so we can pipe the
      // user's message in as a JSON event (no `-p` flag). Closing stdin
      // after the write signals end-of-input and claude exits cleanly when
      // the turn completes.
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    session.proc = proc;

    // Write the message as a single JSON event then close stdin. Format
    // matches what interactive-session.ts uses for the chat tab — same CLI
    // contract.
    const payload = `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: message,
      },
    })}\n`;
    try {
      proc.stdin?.write(payload, 'utf8');
      proc.stdin?.end();
    } catch (error) {
      // stdin write failures will surface via the proc 'error' / 'exit'
      // handlers further down. Log here so the cause is visible in dev.
      console.warn(`[orchestrator-session] stdin write failed for ${session.sessionName}:`, error);
    }

    // #457 — Process timeout: kill the claude process if it hangs
    const processTimeout = setTimeout(() => {
      console.warn(`[orchestrator-session] Process timeout (${PROCESS_TIMEOUT_MS}ms) — killing ${session.sessionName}`);
      // Surface the kill to the chat surface so the user sees WHY the turn
      // stopped emitting. Without this the UI just freezes mid-investigation
      // with no terminating assistant message — looks like a hang. The error
      // event is rendered by the chat as a small system-style note at the
      // tail of the turn.
      const minutes = Math.round(PROCESS_TIMEOUT_MS / 60_000);
      onEvent({
        type: 'error',
        error: `Orchestrator hit the ${minutes}-minute turn limit and was terminated. Re-send your message to continue — or break the task into a tighter brief so it fits.`,
      });
      proc.kill('SIGTERM');
      // Force kill after 5s if SIGTERM doesn't work
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5_000);
    }, PROCESS_TIMEOUT_MS);

    // #624 — User-initiated interrupt. The AbortSignal is the plumbing; the
    // actual stop is SIGTERM to the streaming claude subprocess (same mechanism
    // the timeout path above uses). Events already delivered via onEvent stay
    // in the transcript — we only suppress NEW output after the abort.
    const userAbortSignal = options.signal;
    let userAbortListener: (() => void) | null = null;
    if (userAbortSignal) {
      if (userAbortSignal.aborted) {
        console.log(`[orchestrator-session] Abort requested before spawn listener attached — killing ${session.sessionName}`);
        proc.kill('SIGTERM');
      } else {
        userAbortListener = () => {
          console.log(`[orchestrator-session] User interrupt — killing ${session.sessionName}`);
          if (!proc.killed) proc.kill('SIGTERM');
          setTimeout(() => {
            if (!proc.killed) proc.kill('SIGKILL');
          }, 2_000);
        };
        userAbortSignal.addEventListener('abort', userAbortListener, { once: true });
      }
    }
    const detachUserAbortListener = () => {
      if (userAbortSignal && userAbortListener) {
        userAbortSignal.removeEventListener('abort', userAbortListener);
        userAbortListener = null;
      }
    };

    let lineBuffer = '';
    let sessionId: string | null = session.claudeSessionId;
    let cost: number | null = null;
    const toolTracker = createToolCallTracker();
    // Accumulate the tail of the assistant's final text so we can detect
    // narrate-and-exit turns — where the model runs tools and then ends the
    // turn without emitting a VERDICT or Dispatched summary.
    let lastAssistantText = '';
    let sawToolUseAfterText = false;
    let launchAgentCallCount = 0;
    const captureEvent = (e: OrchestratorEvent) => {
      if (e.type === 'text') {
        lastAssistantText += e.text;
        sawToolUseAfterText = false;
      } else if (e.type === 'tool_use') {
        sawToolUseAfterText = true;
        // Track cortex_launch_agent specifically so we can catch the
        // "claimed dispatch but didn't fire" failure mode distinctly from
        // generic narrate-and-exit. See the runtime check on turn close.
        if (e.name === 'cortex_launch_agent' || e.name === 'mcp__cortex__cortex_launch_agent') {
          launchAgentCallCount += 1;
        }
      }
      onEvent(e);
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString('utf-8');
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? ''; // Keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          processStreamEvent(event, captureEvent, (id) => { sessionId = id; }, (c) => { cost = c; }, toolTracker);
        } catch {
          // Not JSON — ignore
        }
      }
    });

    // Capture stderr for error reporting
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    proc.on('error', (err) => {
      clearTimeout(processTimeout);
      detachUserAbortListener();
      session.status = 'dead';
      session.proc = null;
      onEvent({ type: 'error', error: err.message });
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(processTimeout);
      detachUserAbortListener();
      session.proc = null;

      // Process any remaining buffer
      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer) as Record<string, unknown>;
          processStreamEvent(event, captureEvent, (id) => { sessionId = id; }, (c) => { cost = c; }, toolTracker);
        } catch {
          // ignore
        }
      }

      // Update session state
      if (sessionId) session.claudeSessionId = sessionId;
      session.status = code === 0 ? 'ready' : 'dead';

      // Narrate-and-exit telemetry: a clean-exit turn should END with a text
      // summary that includes a VERDICT or Dispatched marker. If the last
      // assistant content was a tool call and no subsequent text was emitted,
      // the model silently dropped the turn — log it so we can measure how
      // often the new prompt rules are holding.
      if (code === 0) {
        const tail = lastAssistantText.trim().slice(-1200);
        const hasSummaryMarker = /VERDICT\s*[#\-]|Dispatched\s+\d+\s+agent/i.test(tail);
        if (sawToolUseAfterText || !hasSummaryMarker) {
          console.warn(
            `[orchestrator-session] narrate-and-exit suspected for ${session.sessionName}: ` +
            `sawToolUseAfterText=${sawToolUseAfterText} hasSummaryMarker=${hasSummaryMarker} ` +
            `tailLen=${tail.length}`,
          );
        }

        // Dispatch-word check: if the orchestrator claims it dispatched but no
        // cortex_launch_agent actually fired, this is the failure mode from the
        // 2026-04-16 session — operator reads "#X dispatched" and walks away
        // while the lane never existed. Distinct from generic narrate-and-exit
        // because the operator can't tell from the text alone. Log at WARN
        // with a dedicated marker so telemetry and tail-readers spot it fast.
        const dispatchClaimPattern = /\b(dispatched|launched|fired|launching|polling|kicked off)\b/i;
        if (launchAgentCallCount === 0 && dispatchClaimPattern.test(lastAssistantText)) {
          console.warn(
            `[orchestrator-session] FALSE-DISPATCH suspected for ${session.sessionName}: ` +
            `launchAgentCallCount=0 but text claims dispatch — text sample: ` +
            JSON.stringify(lastAssistantText.slice(-200)),
          );
        }
      }

      onEvent({ type: 'done', sessionId, cost });

      if (code !== 0 && stderr) {
        onEvent({ type: 'error', error: stderr.slice(0, 500) });
      }

      resolve();
    });
  });
}
