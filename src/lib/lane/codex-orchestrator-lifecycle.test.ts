import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const resolveCliMock = vi.hoisted(() => vi.fn(async () => ({ path: process.execPath, version: '0.140.0' })));
const backendSessions = vi.hoisted(() => new Map<string, string>());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({
  CliNotFoundError: class CliNotFoundError extends Error {},
  resolveCli: resolveCliMock,
}));

vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => ({}) }));
vi.mock('@/lib/mcp/tool-spine/emit-codex', () => ({
  serializeCodexMcpServers: () => '',
  toCodexServersMap: () => ({}),
}));

vi.mock('@/lib/mobile/orchestrator-thread-history', () => ({
  readOrchestratorBackendSessionId: (threadId: string | null, backend: string) => (
    threadId ? backendSessions.get(`${threadId}:${backend}`) ?? null : null
  ),
  writeOrchestratorBackendSessionId: (threadId: string | null, backend: string, sessionId: string | null) => {
    if (!threadId) return;
    const key = `${threadId}:${backend}`;
    if (sessionId) backendSessions.set(key, sessionId);
    else backendSessions.delete(key);
  },
}));

import {
  CODEX_FIRST_EVENT_TIMEOUT_MS,
  ensureCodexOrchestratorSession,
  sendToCodexOrchestrator,
} from './codex-orchestrator-session';
import { writeOrchestratorBackendSessionId } from '@/lib/mobile/orchestrator-thread-history';
import type { OrchestratorEvent } from './orchestrator-stream-events';

class FakeCodexProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = process.pid;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  unref = vi.fn();
  kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    this.killed = true;
    this.signalCode = signal;
    return true;
  });
}

function useFakeProc(): FakeCodexProc {
  const proc = new FakeCodexProc();
  spawnMock.mockReturnValue(proc as unknown as ChildProcess);
  return proc;
}

async function waitForSpawn(): Promise<void> {
  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
}

describe('Codex orchestrator process lifecycle', () => {
  beforeEach(() => {
    process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR = '0';
    backendSessions.clear();
    spawnMock.mockReset();
    resolveCliMock.mockReset();
    resolveCliMock.mockResolvedValue({ path: process.execPath, version: '0.140.0' });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR;
  });

  it('starts a fresh codex exec when the thread only has a Claude backend session id', async () => {
    const threadId = `thoughts-codex-hygiene-${Date.now()}`;
    writeOrchestratorBackendSessionId(threadId, 'claude', 'foreign-claude-session');
    const session = ensureCodexOrchestratorSession(process.cwd(), threadId);
    const proc = useFakeProc();
    const events: OrchestratorEvent[] = [];

    const turn = sendToCodexOrchestrator(session, 'hi', (event) => events.push(event));
    await waitForSpawn();

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(args).not.toContain('resume');
    expect(args).not.toContain('foreign-claude-session');

    proc.stdout.emit('data', Buffer.from('{"type":"thread.started","thread_id":"codex-thread"}\n'));
    proc.exitCode = 0;
    proc.emit('close', 0);
    await turn;
    expect(events.at(-1)).toMatchObject({ type: 'done', sessionId: 'codex-thread' });
  });

  it('aborts a silent child after 45 seconds with error + done and settles immediately', async () => {
    vi.useFakeTimers();
    const session = ensureCodexOrchestratorSession(process.cwd(), `thoughts-watchdog-${Date.now()}`);
    const proc = useFakeProc();
    const events: OrchestratorEvent[] = [];

    const turn = sendToCodexOrchestrator(session, 'hi', (event) => events.push(event));
    await waitForSpawn();
    await vi.advanceTimersByTimeAsync(CODEX_FIRST_EVENT_TIMEOUT_MS);
    await turn;

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(events).toContainEqual({
      type: 'error',
      error: 'Codex produced no output for 45s — the turn was aborted; re-send to retry',
    });
    expect(events.at(-1)?.type).toBe('done');
    expect(session.proc).toBeNull();
    expect(session.status).toBe('dead');
  });

  it('clears the first-event watchdog on a parseable Codex protocol event', async () => {
    vi.useFakeTimers();
    const session = ensureCodexOrchestratorSession(process.cwd(), `thoughts-first-event-${Date.now()}`);
    const proc = useFakeProc();

    const turn = sendToCodexOrchestrator(session, 'hi', () => {});
    await waitForSpawn();
    proc.stdout.emit('data', Buffer.from('{"type":"thread.started","thread_id":"codex-live"}\n'));
    await vi.advanceTimersByTimeAsync(CODEX_FIRST_EVENT_TIMEOUT_MS);

    expect(proc.kill).not.toHaveBeenCalled();
    proc.exitCode = 0;
    proc.emit('close', 0);
    await turn;
  });

  it('settles and kills the child when Stop arrives during the silent window', async () => {
    const session = ensureCodexOrchestratorSession(process.cwd(), `thoughts-abort-${Date.now()}`);
    const proc = useFakeProc();
    const controller = new AbortController();
    const events: OrchestratorEvent[] = [];

    const turn = sendToCodexOrchestrator(session, 'hi', (event) => events.push(event), { signal: controller.signal });
    await waitForSpawn();
    controller.abort();
    await turn;

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(events.at(-1)?.type).toBe('done');
    expect(session.proc).toBeNull();
  });

  it('settles without spawning when Stop arrives during CLI resolution', async () => {
    let releaseResolver: (value: { path: string; version: string }) => void = () => {
      throw new Error('resolver was not armed');
    };
    resolveCliMock.mockImplementationOnce(() => new Promise((resolve) => { releaseResolver = resolve; }));
    const session = ensureCodexOrchestratorSession(process.cwd(), `thoughts-resolve-abort-${Date.now()}`);
    const controller = new AbortController();
    const events: OrchestratorEvent[] = [];

    const turn = sendToCodexOrchestrator(session, 'hi', (event) => events.push(event), { signal: controller.signal });
    await vi.waitFor(() => expect(resolveCliMock).toHaveBeenCalledTimes(1));
    controller.abort();
    releaseResolver({ path: process.execPath, version: '0.140.0' });
    await turn;

    expect(spawnMock).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe('done');
    expect(session.status).toBe('ready');
  });
});
