import 'server-only';

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createClaudeCodeStreamJsonParser,
} from './stream-json-parser';
import type {
  ClaudeCodeStreamJsonParser,
  ClaudeCodeStreamJsonParserEvent,
  ClaudeCodeStreamJsonParserOptions,
} from './stream-json-parser';

export type ClaudeCodeInteractiveSessionStatus = 'ready' | 'busy' | 'dead';

export interface ClaudeCodeInteractiveSession {
  tabId: string;
  cwd: string;
  model: string | null;
  proc: ChildProcessWithoutNullStreams;
  sessionId: string | null;
  status: ClaudeCodeInteractiveSessionStatus;
  stdinWritable: boolean;
  createdAt: number;
  lastUsedAt: number;
}

export interface SendClaudeCodeInteractiveMessageOptions extends ClaudeCodeStreamJsonParserOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

type InteractiveTurn = {
  parser: ClaudeCodeStreamJsonParser;
  onEvent: (event: ClaudeCodeStreamJsonParserEvent) => void;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  abortSignal: AbortSignal | null;
  abortListener: (() => void) | null;
  settled: boolean;
};

interface InternalClaudeCodeInteractiveSession extends ClaudeCodeInteractiveSession {
  idleTimer: ReturnType<typeof setTimeout> | null;
  stdoutLineBuffer: string;
  stderrBuffer: string;
  activeTurn: InteractiveTurn | null;
}

const PROCESS_TIMEOUT_MS = 480_000;
const IDLE_TIMEOUT_MS = 30 * 60_000;
const sessions = new Map<string, InternalClaudeCodeInteractiveSession>();

function claudeCodeBin(): string {
  return process.env.O8_CLAUDE_CODE_BIN
    || process.env.CLAUDE_BIN
    || join(homedir(), '.local', 'bin', 'claude');
}

function normalizeCwd(cwd: string): string {
  return resolve(cwd.replace(/^~/, homedir())).replace(/\/+$/, '');
}

function normalizeModel(model: string | undefined): string | null {
  const trimmed = model?.trim();
  return trimmed ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sessionIdFromEvent(event: Record<string, unknown>): string | null {
  const type = typeof event.type === 'string' ? event.type : '';
  if (type !== 'init' && type !== 'system' && type !== 'result') {
    return null;
  }

  const rawSessionId = event.session_id ?? event.sessionId;
  return typeof rawSessionId === 'string' && rawSessionId.trim()
    ? rawSessionId
    : null;
}

function buildClaudeArgs(model: string | null): string[] {
  const args = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];

  if (model) {
    args.push('--model', model);
  }

  if (args.includes('-p') || args.includes('--print')) {
    throw new Error('Interactive Claude Code sessions must not use -p/--print');
  }

  return args;
}

function clearIdleTimer(session: InternalClaudeCodeInteractiveSession): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

function killProcess(proc: ChildProcessWithoutNullStreams): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGTERM');
  setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }, 2_000);
}

function detachAbortListener(turn: InteractiveTurn): void {
  if (turn.abortSignal && turn.abortListener) {
    turn.abortSignal.removeEventListener('abort', turn.abortListener);
    turn.abortListener = null;
  }
}

function scheduleIdleKill(session: InternalClaudeCodeInteractiveSession): void {
  clearIdleTimer(session);
  if (session.status === 'dead') return;

  session.idleTimer = setTimeout(() => {
    console.log(`[claude-code-interactive-session] Idle timeout — killing ${session.tabId}`);
    killClaudeCodeInteractiveSession(session.tabId);
  }, IDLE_TIMEOUT_MS);
}

function captureSessionIds(session: InternalClaudeCodeInteractiveSession, chunk: string): void {
  session.stdoutLineBuffer += chunk;
  const lines = session.stdoutLineBuffer.split('\n');
  session.stdoutLineBuffer = lines.pop() ?? '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = asRecord(JSON.parse(trimmed));
      const sessionId = parsed ? sessionIdFromEvent(parsed) : null;
      if (sessionId) {
        session.sessionId = sessionId;
      }
    } catch {
      // Ignore non-JSON banners; the stream-json parser applies the same rule.
    }
  }
}

function settleTurn(
  session: InternalClaudeCodeInteractiveSession,
  error: Error | null,
): void {
  const turn = session.activeTurn;
  if (!turn || turn.settled) return;

  turn.settled = true;
  clearTimeout(turn.timeout);
  detachAbortListener(turn);
  session.activeTurn = null;
  session.lastUsedAt = Date.now();

  if (session.status !== 'dead') {
    session.status = 'ready';
    scheduleIdleKill(session);
  }

  if (error) {
    turn.reject(error);
  } else {
    turn.resolve();
  }
}

function flushActiveTurn(
  session: InternalClaudeCodeInteractiveSession,
): boolean {
  const turn = session.activeTurn;
  if (!turn) return false;

  let emittedDone = false;
  for (const event of turn.parser.flush()) {
    if (event.type === 'done' && event.sessionId) {
      session.sessionId = event.sessionId;
    }
    if (event.type === 'done') {
      emittedDone = true;
    }
    turn.onEvent(event);
  }
  return emittedDone;
}

function handleParserEvents(
  session: InternalClaudeCodeInteractiveSession,
  events: ClaudeCodeStreamJsonParserEvent[],
): void {
  const turn = session.activeTurn;
  if (!turn) return;

  for (const event of events) {
    if (event.type === 'done' && event.sessionId) {
      session.sessionId = event.sessionId;
    }
    turn.onEvent(event);
    if (event.type === 'done') {
      settleTurn(session, null);
    }
  }
}

function markDead(session: InternalClaudeCodeInteractiveSession): void {
  clearIdleTimer(session);
  session.status = 'dead';
  session.stdinWritable = false;
}

function attachProcessHandlers(session: InternalClaudeCodeInteractiveSession): void {
  const { proc } = session;

  proc.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    captureSessionIds(session, text);
    const turn = session.activeTurn;
    if (turn) {
      handleParserEvents(session, turn.parser.pushChunk(text));
    }
  });

  proc.stderr.on('data', (chunk: Buffer) => {
    session.stderrBuffer += chunk.toString('utf8');
    if (session.stderrBuffer.length > 4_000) {
      session.stderrBuffer = session.stderrBuffer.slice(-4_000);
    }
  });

  proc.stdin.on('error', () => {
    session.stdinWritable = false;
  });
  proc.stdin.on('close', () => {
    session.stdinWritable = false;
  });
  proc.stdin.on('finish', () => {
    session.stdinWritable = false;
  });

  proc.on('error', (err) => {
    markDead(session);
    settleTurn(session, err);
  });

  proc.on('close', (code, signal) => {
    markDead(session);
    const emittedDone = flushActiveTurn(session);
    if (!session.activeTurn) return;
    if (emittedDone) {
      settleTurn(session, null);
      return;
    }

    const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
    const stderr = session.stderrBuffer.trim();
    const error = new Error(
      `Claude Code interactive session exited before completing the turn (${suffix})${stderr ? `: ${stderr.slice(0, 500)}` : ''}`,
    );
    settleTurn(session, error);
  });
}

function spawnSession(
  tabId: string,
  cwd: string,
  model: string | null,
): InternalClaudeCodeInteractiveSession {
  const proc = spawn(claudeCodeBin(), buildClaudeArgs(model), {
    cwd,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      O8_MANAGED_SESSION: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const session: InternalClaudeCodeInteractiveSession = {
    tabId,
    cwd,
    model,
    proc,
    sessionId: null,
    status: 'ready',
    stdinWritable: Boolean(proc.stdin.writable && !proc.stdin.destroyed),
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    idleTimer: null,
    stdoutLineBuffer: '',
    stderrBuffer: '',
    activeTurn: null,
  };

  attachProcessHandlers(session);
  scheduleIdleKill(session);
  sessions.set(tabId, session);
  console.log(`[claude-code-interactive-session] Spawned ${tabId} in ${cwd}`);
  return session;
}

export function getClaudeCodeInteractiveSession(
  tabId: string,
): ClaudeCodeInteractiveSession | null {
  return sessions.get(tabId) ?? null;
}

export function ensureSession(
  tabId: string,
  cwd: string,
  model?: string,
): ClaudeCodeInteractiveSession {
  const normalizedCwd = normalizeCwd(cwd);
  const normalizedModel = normalizeModel(model);
  const existing = sessions.get(tabId);

  if (
    existing
    && existing.status !== 'dead'
    && existing.cwd === normalizedCwd
    && existing.model === normalizedModel
  ) {
    return existing;
  }

  if (existing) {
    killClaudeCodeInteractiveSession(tabId);
  }

  return spawnSession(tabId, normalizedCwd, normalizedModel);
}

export async function sendMessage(
  session: ClaudeCodeInteractiveSession,
  text: string,
  onEvent: (event: ClaudeCodeStreamJsonParserEvent) => void,
  options: SendClaudeCodeInteractiveMessageOptions = {},
): Promise<void> {
  const internal = session as InternalClaudeCodeInteractiveSession;
  if (!text.trim()) {
    throw new Error('Message is required');
  }
  if (internal.status === 'dead') {
    throw new Error('Claude Code interactive session is dead');
  }
  if (internal.status === 'busy') {
    throw new Error('Claude Code interactive session is busy');
  }
  if (!internal.stdinWritable || internal.proc.stdin.destroyed) {
    internal.status = 'dead';
    throw new Error('Claude Code interactive session stdin is not writable');
  }

  clearIdleTimer(internal);
  internal.status = 'busy';
  internal.lastUsedAt = Date.now();

  return new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      console.warn(`[claude-code-interactive-session] Process timeout (${options.timeoutMs ?? PROCESS_TIMEOUT_MS}ms) — killing ${internal.tabId}`);
      killClaudeCodeInteractiveSession(internal.tabId);
      settleTurn(internal, new Error('Claude Code interactive session timed out'));
    }, options.timeoutMs ?? PROCESS_TIMEOUT_MS);

    const turn: InteractiveTurn = {
      parser: createClaudeCodeStreamJsonParser(options),
      onEvent,
      resolve: resolvePromise,
      reject: rejectPromise,
      timeout,
      abortSignal: options.signal ?? null,
      abortListener: null,
      settled: false,
    };
    internal.activeTurn = turn;

    if (options.signal) {
      if (options.signal.aborted) {
        killClaudeCodeInteractiveSession(internal.tabId);
        settleTurn(internal, new Error('Claude Code interactive session was aborted'));
        return;
      }
      turn.abortListener = () => {
        console.log(`[claude-code-interactive-session] User interrupt — killing ${internal.tabId}`);
        killClaudeCodeInteractiveSession(internal.tabId);
        settleTurn(internal, new Error('Claude Code interactive session was aborted'));
      };
      options.signal.addEventListener('abort', turn.abortListener, { once: true });
    }

    const payload = `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: text,
      },
    })}\n`;

    try {
      internal.proc.stdin.write(payload, 'utf8', (error?: Error | null) => {
        if (error) {
          internal.stdinWritable = false;
          internal.status = 'dead';
          settleTurn(internal, error);
        }
      });
    } catch (error) {
      internal.stdinWritable = false;
      internal.status = 'dead';
      settleTurn(
        internal,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  });
}

export function killClaudeCodeInteractiveSession(tabId: string): boolean {
  const session = sessions.get(tabId);
  if (!session) return false;

  markDead(session);
  sessions.delete(tabId);
  killProcess(session.proc);
  return true;
}

export function killSession(tabId: string): boolean {
  return killClaudeCodeInteractiveSession(tabId);
}

export function killAllClaudeCodeInteractiveSessions(): void {
  for (const tabId of Array.from(sessions.keys())) {
    killClaudeCodeInteractiveSession(tabId);
  }
}
