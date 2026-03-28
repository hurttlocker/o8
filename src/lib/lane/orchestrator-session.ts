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
const MCP_SERVER_PATH = resolve(dirname(new URL(import.meta.url).pathname), '../mcp/cortex-mcp-server.ts');
const MCP_CONFIG_DIR = join(homedir(), '.cortex-ide', 'mcp');

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
  const apiBase = `http://localhost:${process.env.PORT || '3001'}`;

  // Use npx tsx to run the TS server directly in dev; in prod this would be compiled
  const config = {
    mcpServers: {
      cortex: {
        command: 'npx',
        args: ['tsx', MCP_SERVER_PATH],
        env: {
          CORTEX_API_BASE: apiBase,
          CORTEX_REPO_PATH: repoPath,
          CORTEX_REPO_SLUG: repoSlug,
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
  return [
    `You are the orchestrator for Cortex IDE — a command center for managing AI agent fleets.`,
    `You are working inside the repo "${repoName}" at ${repoPath}.`,
    ``,
    `Your role:`,
    `- You are the user's senior engineering partner. Think strategically, act precisely.`,
    `- You have full access to this repo via Claude Code tools (read, write, edit, bash, grep, glob).`,
    `- When the user asks you to build, fix, or change something — do it directly. Don't just describe what to do.`,
    `- Be concise. Lead with action, not explanation. Skip preamble.`,
    `- When you complete a task, say what you did in 1-2 sentences. Don't narrate every step.`,
    ``,
    `Context:`,
    `- This conversation persists across messages via --resume. You have full conversation history.`,
    `- The user may reference "lanes" (durable agent work units), "packets" (planned work items), or "runtimes" (Claude Code and Codex sessions). OpenClaw is a separate legacy system — ignore it.`,
    `- You are running with --dangerously-skip-permissions so you can act autonomously. Use good judgment.`,
    `- Prefer editing existing files over creating new ones. Follow the repo's existing patterns.`,
    `- Run \`npx tsc --noEmit\` to verify TypeScript changes before reporting completion.`,
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
    `When the user asks you to do parallel work or delegate tasks, launch Codex agents. You are Claude (the orchestrator) — Codex agents are your workers.`,
    `For complex tasks, break work into parts and launch separate agents for each. Monitor their progress and steer if needed.`,
  ].join('\n');
}

// ── Registry ──

const sessions = new Map<string, OrchestratorSession>();

function repoHash(repoPath: string): string {
  return createHash('sha256').update(repoPath).digest('hex').slice(0, 8);
}

export function orchestratorSessionName(repoPath: string): string {
  return `cortex-orchestrator-${repoHash(repoPath)}`;
}

export function getOrchestratorSession(repoPath: string): OrchestratorSession | null {
  return sessions.get(orchestratorSessionName(repoPath)) ?? null;
}

export function getAllOrchestratorSessions(): OrchestratorSession[] {
  return [...sessions.values()];
}

// ── Ensure session exists ──

export function ensureOrchestratorSession(repoPath: string): OrchestratorSession {
  const sessionName = orchestratorSessionName(repoPath);
  const existing = sessions.get(sessionName);

  if (existing && existing.status !== 'dead') {
    return existing;
  }

  const session: OrchestratorSession = {
    sessionName,
    repoPath,
    claudeSessionId: null,
    status: 'ready',
    proc: null,
    createdAt: Date.now(),
  };
  sessions.set(sessionName, session);
  console.log(`[orchestrator-session] Created ${sessionName} for ${repoPath}`);
  return session;
}

// ── Send message (spawn process, stream JSON) ──

/**
 * Sends a message to the orchestrator. Spawns a claude process that outputs
 * stream-json. Calls `onEvent` for each parsed event. Returns when the
 * process exits.
 */
export async function sendToOrchestrator(
  session: OrchestratorSession,
  message: string,
  onEvent: (event: OrchestratorEvent) => void,
): Promise<void> {
  if (session.status === 'dead') {
    throw new Error('Orchestrator session is dead');
  }
  if (session.status === 'busy') {
    throw new Error('Orchestrator session is busy');
  }

  session.status = 'busy';

  // Generate MCP config so Claude Code can use Cortex tools
  const mcpConfigPath = ensureMcpConfig(session.repoPath);

  const args: string[] = [
    '-p', message,
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--verbose',
    '--mcp-config', mcpConfigPath,
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
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    session.proc = proc;

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
      session.status = 'dead';
      session.proc = null;
      onEvent({ type: 'error', error: err.message });
      reject(err);
    });

    proc.on('close', (code) => {
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

// ── Kill / cleanup ──

export function killOrchestratorSession(repoPath: string): void {
  const sessionName = orchestratorSessionName(repoPath);
  const session = sessions.get(sessionName);
  if (!session) return;

  if (session.proc) {
    try { session.proc.kill('SIGTERM'); } catch { /* already gone */ }
    session.proc = null;
  }

  session.status = 'dead';
  sessions.delete(sessionName);
  console.log(`[orchestrator-session] Killed ${sessionName}`);
}

// ── Helpers ──

/**
 * Try to detect if a tmux session is still alive.
 * Kept for backward compatibility with other callers.
 */
export function isTmuxSessionAlive(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t ${sessionName} 2>/dev/null`, {
      timeout: 3000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}
