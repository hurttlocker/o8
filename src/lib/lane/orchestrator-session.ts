/**
 * Orchestrator session — runs Claude Code in non-interactive mode with
 * structured JSON output. Each message spawns a short-lived process:
 *
 *   claude -p "message" --output-format stream-json --dangerously-skip-permissions
 *
 * Conversation context persists via `--resume SESSION_ID` on follow-up
 * messages. This avoids all TUI/ANSI parsing issues.
 */

import { createHash } from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listActiveLanesWithSessions } from '@/lib/lane/registry';
import {
  createToolCallTracker,
  processStreamEvent,
  type OrchestratorEvent,
} from '@/lib/lane/orchestrator-stream-events';
import { externalServerToMcpConfig, listEnabledExternalMcpServers } from '@/lib/mcp/external-servers';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { getRuntime, type RuntimeSession } from '@/lib/runtimes';
import { getOrCreateWsToken } from '@/lib/ws-auth';

// ── Types ──

export interface OrchestratorSession {
  sessionName: string;
  repoPath: string;
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

/**
 * Resolve the Cortex MCP server entry point.
 *
 * In a packaged Tauri app the TS source isn't shipped — only the esbuild
 * output in `resource_dir/server/cortex-mcp-server.mjs`. The Rust sidecar
 * sets `O8_BUNDLED_MCP_DIR` to the resource/server directory before spawning
 * Next, so we prefer the bundled .mjs when it exists.
 *
 * Dev checkout falls back to the TS source run under `tsx`.
 */
function resolveCortexMcpServerPath(): { command: string; path: string } {
  const bundledDir = process.env.O8_BUNDLED_MCP_DIR;
  if (bundledDir) {
    const bundled = join(bundledDir, 'cortex-mcp-server.mjs');
    if (existsSync(bundled)) {
      // Prefer the node path the Tauri sidecar resolved via login shell
      // (handles nvm/fnm/volta that Finder's minimal PATH misses).
      const nodeBin = process.env.O8_NODE_BIN || 'node';
      return { command: nodeBin, path: bundled };
    }
  }
  const devSource = resolve(dirname(new URL(import.meta.url).pathname), '../mcp/cortex-mcp-server.ts');
  return { command: 'npx', path: devSource };
}

function resolveOperatorMcpServerPath(): { command: string; path: string } {
  const bundledDir = process.env.O8_BUNDLED_MCP_DIR;
  if (bundledDir) {
    const bundled = join(bundledDir, 'operator-mcp-server.mjs');
    if (existsSync(bundled)) {
      const nodeBin = process.env.O8_NODE_BIN || 'node';
      return { command: nodeBin, path: bundled };
    }
  }
  const devSource = resolve(dirname(new URL(import.meta.url).pathname), '../mcp/operator-mcp-server.ts');
  return { command: 'npx', path: devSource };
}

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
const PROCESS_TIMEOUT_MS = 480_000;

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

function orchestratorResetSignalPath(repoPath: string): string {
  return join(ORCHESTRATOR_STATE_DIR, `session-reset-${repoHash(normalizeRepoPath(repoPath))}.json`);
}

function writeOrchestratorResetSignal(repoPath: string): void {
  ensureOrchestratorStateDir();
  writeFileSync(
    orchestratorResetSignalPath(repoPath),
    `${JSON.stringify({ repoPath: normalizeRepoPath(repoPath), requestedAt: Date.now() })}\n`,
    'utf8',
  );
}

function consumeOrchestratorResetSignal(repoPath: string): boolean {
  const signalPath = orchestratorResetSignalPath(repoPath);
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

/** Resolve repo slug from git remote, cached per session. */
function detectRepoSlug(repoPath: string): string {
  try {
    const remote = execSync('git remote get-url origin', { cwd: repoPath, timeout: 3000, encoding: 'utf-8' }).trim();
    const match = remote.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    return match?.[1] ?? '';
  } catch { return ''; }
}

/** Generate a temporary MCP config file for orchestrator context sources. */
function ensureMcpConfig(repoPath: string): string {
  if (!existsSync(MCP_CONFIG_DIR)) mkdirSync(MCP_CONFIG_DIR, { recursive: true });

  const configPath = join(MCP_CONFIG_DIR, `orchestrator-${repoHash(repoPath)}.json`);
  const repoSlug = detectRepoSlug(repoPath);
  // Use the shared port resolver so MCP children agree with the live backend
  // (which may be on 3001 in dev but 3002+ in a packaged install with a port
  // collision — see src/lib/panel/api-port.ts).
  const { getApiBase } = require('@/lib/panel/api-port') as typeof import('@/lib/panel/api-port');
  const apiBase = getApiBase();

  const cortexServer = resolveCortexMcpServerPath();
  const cortexArgs = cortexServer.command === 'npx'
    ? ['tsx', cortexServer.path]
    : [cortexServer.path];

  const operatorServer = resolveOperatorMcpServerPath();
  const operatorArgs = operatorServer.command === 'npx'
    ? ['tsx', operatorServer.path]
    : [operatorServer.path];

  const externalServers: Record<string, ReturnType<typeof externalServerToMcpConfig>> = {};
  try {
    for (const server of listEnabledExternalMcpServers()) {
      externalServers[server.name] = externalServerToMcpConfig(server);
    }
  } catch (error) {
    console.warn(
      `[orchestrator-session] Failed to load external MCP servers: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const config = {
    mcpServers: {
      ...externalServers,
      operator: {
        type: 'stdio' as const,
        command: operatorServer.command,
        args: operatorArgs,
        env: {
          O8_API_BASE: apiBase,
        },
      },
      cortex: {
        type: 'stdio' as const,
        command: cortexServer.command,
        args: cortexArgs,
        env: {
          CORTEX_API_BASE: apiBase,
          CORTEX_REPO_PATH: repoPath,
          CORTEX_REPO_SLUG: repoSlug,
          WS_PORT: String(process.env.WS_PORT || '3002'),
          WS_TOKEN: getOrCreateWsToken(),
        },
      },
    },
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

export function orchestratorSessionName(repoPath: string): string {
  return `cortex-orchestrator-${repoHash(normalizeRepoPath(repoPath))}`;
}

export function getOrchestratorSession(repoPath: string): OrchestratorSession | null {
  void rehydrateOrchestratorSessions().catch(() => {
    // Startup rehydration is best-effort; callers can still create a fresh session.
  });
  return sessions.get(orchestratorSessionName(repoPath)) ?? null;
}

export function requestOrchestratorSessionReset(repoPath: string): { repoPath: string; sessionName: string } {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const sessionName = orchestratorSessionName(normalizedRepoPath);

  writeOrchestratorResetSignal(normalizedRepoPath);

  const session = sessions.get(sessionName);
  if (session) {
    session.claudeSessionId = null;
  }

  return { repoPath: normalizedRepoPath, sessionName };
}

// ── Ensure session exists ──

export function ensureOrchestratorSession(repoPath: string): OrchestratorSession {
  void rehydrateOrchestratorSessions().catch(() => {
    // Startup rehydration is best-effort; callers can still create a fresh session.
  });

  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const sessionName = orchestratorSessionName(normalizedRepoPath);
  const existing = sessions.get(sessionName);

  if (existing && existing.status !== 'dead') {
    return existing;
  }

  const session: OrchestratorSession = {
    sessionName,
    repoPath: normalizedRepoPath,
    claudeSessionId: null,
    status: 'ready',
    proc: null,
    createdAt: Date.now(),
  };
  sessions.set(sessionName, session);
  console.log(`[orchestrator-session] Created ${sessionName} for ${normalizedRepoPath}`);
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
export const DEFAULT_ORCHESTRATOR_MODEL = 'claude-opus-4-7';

export interface SendToOrchestratorOptions {
  permissionMode?: OrchestratorPermissionMode;
  thinkingEffort?: ThinkingEffort;
  model?: string;
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

  // #457 — Auto-recover dead sessions by creating a fresh one
  if (session.status === 'dead') {
    console.log(`[orchestrator-session] Auto-recovering dead session ${session.sessionName}`);
    session.status = 'ready';
    session.claudeSessionId = null;
    session.proc = null;
  }
  if (session.status === 'busy') {
    throw new Error('Orchestrator session is busy');
  }

  if (consumeOrchestratorResetSignal(session.repoPath)) {
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

  const args: string[] = [
    '-p', message,
    '--output-format', 'stream-json',
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

  return new Promise<void>((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, {
      cwd: session.repoPath,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      // We pass the full prompt via the `-p` CLI flag, not via stdin.
      // Leaving stdin on 'pipe' causes Claude Code to wait 3s for input
      // that never arrives, then warn "no stdin data received in 3s,
      // proceeding without it" and drop the warning into the transcript.
      // Ignore stdin so the CLI knows there's nothing to read.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    session.proc = proc;

    // #457 — Process timeout: kill the claude process if it hangs
    const processTimeout = setTimeout(() => {
      console.warn(`[orchestrator-session] Process timeout (${PROCESS_TIMEOUT_MS}ms) — killing ${session.sessionName}`);
      proc.kill('SIGTERM');
      // Force kill after 5s if SIGTERM doesn't work
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5_000);
    }, PROCESS_TIMEOUT_MS);

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
      session.status = 'dead';
      session.proc = null;
      onEvent({ type: 'error', error: err.message });
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(processTimeout);
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
