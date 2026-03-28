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
import { homedir } from 'node:os';
import { join } from 'node:path';

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

  const args: string[] = [
    '-p', message,
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--verbose',
  ];

  // Resume existing conversation if we have a session ID
  if (session.claudeSessionId) {
    args.push('--resume', session.claudeSessionId);
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
