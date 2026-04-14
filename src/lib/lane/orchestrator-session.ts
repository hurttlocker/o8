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
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { listActiveLanesWithSessions } from '@/lib/lane/registry';
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

/** Structured events emitted from the JSON stream */
export type OrchestratorEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; output: string }
  | { type: 'done'; sessionId: string | null; cost: number | null }
  | { type: 'error'; error: string };

// ── Constants ──

const CLAUDE_BIN = process.env.CLAUDE_BIN || join(homedir(), '.local', 'bin', 'claude');

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

const MCP_CONFIG_DIR = join(homedir(), '.o8', 'mcp');
const LOG_PREFIX = '[orchestrator-rehydrate]';
/** #457 — Kill the claude process if it doesn't finish within this window */
const PROCESS_TIMEOUT_MS = 90_000;

let startupRehydrationPromise: Promise<void> | null = null;
let startupRehydrationComplete = false;

function normalizeRepoPath(repoPath: string): string {
  return resolve(repoPath).replace(/\/+$/, '');
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

/** Generate a temporary MCP config file pointing to the Cortex MCP server. */
function ensureMcpConfig(repoPath: string): string {
  if (!existsSync(MCP_CONFIG_DIR)) mkdirSync(MCP_CONFIG_DIR, { recursive: true });

  const configPath = join(MCP_CONFIG_DIR, `orchestrator-${repoHash(repoPath)}.json`);
  const repoSlug = detectRepoSlug(repoPath);
  // Use the shared port resolver so MCP children agree with the live backend
  // (which may be on 3001 in dev but 3002+ in a packaged install with a port
  // collision — see src/lib/panel/api-port.ts).
  const { getApiBase } = require('@/lib/panel/api-port') as typeof import('@/lib/panel/api-port');
  const apiBase = getApiBase();

  // Dev: `npx tsx <ts source>`. Packaged app: `node <bundled .mjs>`.
  const mcpServer = resolveCortexMcpServerPath();
  const args = mcpServer.command === 'npx'
    ? ['tsx', mcpServer.path]
    : [mcpServer.path];

  const config = {
    mcpServers: {
      cortex: {
        command: mcpServer.command,
        args,
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

/** Appended to Claude Code's default system prompt on the first message only. */
function buildOrchestratorSystemPrompt(repoPath: string): string {
  const repoName = repoPath.split('/').filter(Boolean).pop() ?? repoPath;

  // Load all registered repos for fleet awareness
  let allRepos: Array<{ name: string; localPath: string }> = [];
  try {
    const reposFile = join(homedir(), '.o8', 'repos.json');
    if (existsSync(reposFile)) {
      const { readFileSync } = require('node:fs');
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

  return [
    `You are the orchestrator for o8 — the fleet-level brain for managing AI agent teams across all repos.`,
    ``,
    `Your primary repo is "${repoName}" at ${repoPath}, but you are fleet-aware.`,
    `All registered repos:`,
    repoList,
    ``,
    `You can work across any repo. Use absolute paths when accessing files outside your primary repo. When the user mentions a repo by name, infer the correct path from the list above. For git operations in other repos, \`cd\` into that repo first.`,
    ``,
    `Your role:`,
    `- You are the user's senior engineering partner. Think strategically, act precisely.`,
    `- You have full access to all repos via Claude Code tools (read, write, edit, bash, grep, glob).`,
    `- When the user asks you to build, fix, or change something — do it directly. Don't just describe what to do. If the target repo isn't your cwd, cd into it first.`,
    `- Be concise. Lead with action, not explanation. Skip preamble.`,
    `- When you complete a task, say what you did in 1-2 sentences. Don't narrate every step.`,
    ``,
    `Context:`,
    `- This conversation persists across messages via --resume. You have full conversation history.`,
    `- The user may reference "lanes" (durable agent work units), "packets" (planned work items), or "runtimes" (Claude Code and Codex sessions). Stay focused on the active CLI runtimes.`,
    `- Each message you receive may be sent in "Full access" or "Read-only" mode. Full access lets you edit files and run side-effecting commands; read-only limits you to inspection tools and MCP queries, with writes gated by user approval. Respect the mode you're in on each turn.`,
    `- Prefer editing existing files over creating new ones. Follow the repo's existing patterns.`,
    `- Run \`npx tsc --noEmit\` to verify TypeScript changes before reporting completion.`,
    `- ALWAYS use cortex_list_issues / cortex_list_prs / cortex_ci_status for GitHub data. NEVER use the gh CLI — it uses a personal token that hits rate limits. The MCP tools use a GitHub App with separate quota.`,
    ``,
    `Cortex tools available (via MCP):`,
    `Awareness:`,
    `- cortex_fleet_status — see all active Claude Code and Codex agent sessions`,
    `- cortex_list_issues — GitHub issues for any repo`,
    `- cortex_list_prs — open pull requests`,
    `- cortex_ci_status — CI pipeline runs (GitHub Actions)`,
    `- cortex_read_packets — current mission work packets and their status`,
    `- cortex_update_packet — update a work packet (status, title, queue state, etc.)`,
    `- cortex_list_approvals — pending approval requests from agents`,
    `- cortex_resolve_approval — approve or reject a pending approval`,
    `Delegation (Codex agents):`,
    `- cortex_launch_agent — launch a new Codex agent with a task prompt. Returns a surfaceId for tracking.`,
    `- cortex_steer_agent — send follow-up instructions to a running Codex agent`,
    `- cortex_read_transcript — read what an agent has been doing (messages, tool calls, outputs)`,
    `- cortex_interrupt_agent — stop a running agent that's going off-track`,
    ``,
    `## Orchestrator Workflow`,
    ``,
    `You are Claude — the orchestrator. Codex agents are your workers. Follow this protocol:`,
    ``,
    `### 1. PLAN — Decompose user intent into scoped tasks`,
    `When the user gives you an intent (text prompt, issue reference, or feature request):`,
    `- Read the relevant codebase areas first (use your file tools)`,
    `- Break the work into concrete, scoped tasks that a Codex agent can complete independently`,
    `- Present the plan to the user as a brief numbered list`,
    `- Each task should be small enough for one agent to finish in a single session`,
    ``,
    `### 2. DELEGATE — Launch Codex agents for each task`,
    `For each task in the plan:`,
    `- Call cortex_launch_agent with a clear, specific prompt describing exactly what to build/fix/change`,
    `- Set isolate=true so the agent works in its own git worktree (never on main)`,
    `- Include file paths, function names, and expected behavior in the prompt`,
    `- One agent per task. Sequential for now — wait for each to finish before launching the next.`,
    ``,
    `### 3. MONITOR — Track agent progress`,
    `After launching an agent:`,
    `- Use cortex_fleet_status to check if the agent is still running or has finished`,
    `- Use cortex_read_transcript to see what the agent has been doing`,
    `- If an agent is going off-track, use cortex_steer_agent to redirect or cortex_interrupt_agent to stop it`,
    ``,
    `### 4. REVIEW — Evaluate the agent's output`,
    `When an agent finishes (status becomes idle/reviewing):`,
    `- Read the agent's transcript to understand what was done`,
    `- Review the changed files in the agent's worktree`,
    `- Evaluate: Does this match the task intent? Any regressions? Follows project conventions?`,
    `- Write a concise review summary (2-4 sentences): what was changed, whether it's correct, any concerns`,
    ``,
    `### 5. APPROVE — Surface results for human decision`,
    `After reviewing, create an approval for the user:`,
    `- If the work looks good: tell the user what was done and recommend approval`,
    `- If there are issues: describe the problems and recommend denial or a fix`,
    `- The user will see your review summary on their approval card (desktop and mobile)`,
    `- The user approves or denies. On approval, the work merges automatically.`,
    ``,
    `### Key Rules`,
    `- NEVER merge directly. All merges go through the approval system.`,
    `- NEVER skip the review step. You are the trust layer between agents and the codebase.`,
    `- Keep review summaries concise — the user doesn't read code. Your summary IS their understanding.`,
    `- If a task is simple enough to do yourself (quick edit, config change), just do it directly instead of delegating.`,
    `- Run \`npx tsc --noEmit\` in the worktree after reviewing to verify the agent's work compiles.`,
  ].join('\n');
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

export type ThinkingEffort = 'medium' | 'high' | 'max';

export interface SendToOrchestratorOptions {
  permissionMode?: OrchestratorPermissionMode;
  thinkingEffort?: ThinkingEffort;
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
  const thinkingEffort: ThinkingEffort = options.thinkingEffort ?? 'max';

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

  session.status = 'busy';

  // Generate MCP config so Claude Code can use Cortex tools
  const mcpConfigPath = ensureMcpConfig(session.repoPath);

  // Map thinking effort to Claude Code CLI's --effort flag.
  const effortMap: Record<ThinkingEffort, string> = {
    medium: 'medium',
    high: 'high',
    max: 'max',
  };

  const args: string[] = [
    '-p', message,
    '--output-format', 'stream-json',
    ...(permissionMode === 'plan'
      ? ['--permission-mode', 'plan']
      : ['--dangerously-skip-permissions']),
    '--verbose',
    '--mcp-config', mcpConfigPath,
    '--effort', effortMap[thinkingEffort],
  ];

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

    proc.stdout?.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString('utf-8');
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? ''; // Keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          processStreamEvent(event, onEvent, (id) => { sessionId = id; }, (c) => { cost = c; });
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
          processStreamEvent(event, onEvent, (id) => { sessionId = id; }, (c) => { cost = c; });
        } catch {
          // ignore
        }
      }

      // Update session state
      if (sessionId) session.claudeSessionId = sessionId;
      session.status = code === 0 ? 'ready' : 'dead';

      onEvent({ type: 'done', sessionId, cost });

      if (code !== 0 && stderr) {
        onEvent({ type: 'error', error: stderr.slice(0, 500) });
      }

      resolve();
    });
  });
}

/** Parse a single stream-json event and emit structured events. */
function processStreamEvent(
  event: Record<string, unknown>,
  onEvent: (e: OrchestratorEvent) => void,
  onSessionId: (id: string) => void,
  onCost: (cost: number) => void,
): void {
  const type = event.type as string | undefined;

  switch (type) {
    case 'system': {
      const id = event.session_id as string | undefined;
      if (id) onSessionId(id);
      break;
    }

    case 'content_block_delta': {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (!delta) break;
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        onEvent({ type: 'text', text: delta.text });
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        onEvent({ type: 'thinking', text: delta.thinking });
      }
      break;
    }

    case 'content_block_start': {
      const block = event.content_block as Record<string, unknown> | undefined;
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        onEvent({ type: 'tool_use', name: block.name, input: block.input ?? null });
      }
      break;
    }

    case 'assistant': {
      // Full message — extract text content
      const message = event.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            onEvent({ type: 'text', text: b.text });
          } else if (b.type === 'tool_use' && typeof b.name === 'string') {
            onEvent({ type: 'tool_use', name: b.name as string, input: b.input ?? null });
          } else if (b.type === 'tool_result') {
            const resultText = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            onEvent({ type: 'tool_result', name: '', output: resultText });
          }
        }
      }
      break;
    }

    case 'result': {
      const id = event.session_id as string | undefined;
      if (id) onSessionId(id);
      const totalCost = event.total_cost_usd as number | undefined;
      if (typeof totalCost === 'number') onCost(totalCost);
      break;
    }
  }
}
