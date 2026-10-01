import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorEvent } from './orchestrator-stream-events';

const spawnMock = vi.hoisted(() => vi.fn());
const configState = vi.hoisted(() => ({ reversed: false }));
const carrierState = vi.hoisted(() => ({
  source: 'codex-subscription' as 'codex-subscription' | 'openrouter',
  model: 'gpt-5.6-sol',
  baseUrl: 'http://127.0.0.1:8317',
  token: 'local-orchestrator-token',
}));
const resolveCarrierMock = vi.hoisted(() => vi.fn(async ({ sessionDir }: { sessionDir: string }) => ({
  source: carrierState.source,
  model: carrierState.model,
  spawnEnv: {
    ANTHROPIC_BASE_URL: carrierState.baseUrl,
    ANTHROPIC_AUTH_TOKEN: carrierState.token,
    ...(carrierState.source === 'codex-subscription'
      ? { CLAUDE_CONFIG_DIR: `${sessionDir}/claude-code-codex-config` }
      : {}),
  },
  fingerprint: `${carrierState.source}:${carrierState.model}:${sessionDir}`,
})));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => ({}) }));
vi.mock('@/lib/mcp/tool-spine/emit-claude', () => ({
  toClaudeJson: () => configState.reversed
    ? { mcpServers: { cortex: { command: 'cortex' }, operator: { command: 'operator' } } }
    : { mcpServers: { operator: { command: 'operator' }, cortex: { command: 'cortex' } } },
}));
vi.mock('./claude-harness-carrier', () => ({
  resolveClaudeHarnessCarrier: resolveCarrierMock,
  nativeClaudeHarnessCarrier: (model: string) => ({
    source: 'native', model, spawnEnv: {}, fingerprint: `native:${model}`,
  }),
}));

const dataDir = mkdtempSync(join(tmpdir(), 'o8-orchestrator-warm-config-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CLAUDE_CODE_BIN = process.execPath;
process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR = '0';

const {
  ensureOrchestratorSession,
  reloadOrchestratorSession,
  requestOrchestratorSessionReset,
  sendToOrchestrator,
} = await import('./orchestrator-session');
const { readOrchestratorBackendSessionId, writeOrchestratorBackendSessionId } = await import('@/lib/mobile/orchestrator-thread-history');
const { readDeliveredOrchestratorPrompt } = await import('./orchestrator-prompt-ledger');

function writtenTurnText(proc: FakeClaudeProc, call: number): string {
  const payload = JSON.parse(String((proc.stdin.write.mock.calls[call] as unknown[])[0])) as {
    message: { content: string | Array<{ type: string; text?: string }> };
  };
  const { content } = payload.message;
  return typeof content === 'string' ? content : content.map((block) => block.text ?? '').join('');
}

class FakeClaudeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { destroyed: false, writable: true, write: vi.fn(() => true) };
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

describe('warm orchestrator MCP config reuse', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    resolveCarrierMock.mockClear();
    configState.reversed = false;
    carrierState.source = 'codex-subscription';
    carrierState.model = 'gpt-5.6-sol';
    carrierState.baseUrl = 'http://127.0.0.1:8317';
    carrierState.token = 'local-orchestrator-token';
  });

  it('reuses the resident process across semantically identical back-to-back turns', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-warm-config-repo-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
    const procs: FakeClaudeProc[] = [];
    spawnMock.mockImplementation(() => {
      const proc = new FakeClaudeProc();
      procs.push(proc);
      return proc as unknown as ChildProcess;
    });
    const session = ensureOrchestratorSession(repoPath, `thoughts-warm-config-${Date.now()}`);

    const firstTurn = sendToOrchestrator(session, 'first', () => {});
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(procs[0]!.stdin.write).toHaveBeenCalledTimes(1));
    procs[0]!.stdout.emit('data', Buffer.from('{"type":"result","session_id":"warm-session"}\n'));
    await firstTurn;

    configState.reversed = true;
    const secondTurn = sendToOrchestrator(session, 'second', () => {});
    await vi.waitFor(() => expect(procs[0]!.stdin.write).toHaveBeenCalledTimes(2));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(procs[0]!.kill).not.toHaveBeenCalled();
    procs[0]!.stdout.emit('data', Buffer.from('{"type":"result","session_id":"warm-session"}\n'));
    await secondTurn;
    procs[0]!.exitCode = 0;
    procs[0]!.emit('close', 0);
  });

  it('keeps separate resident Claude Code Codex sessions for separate orchestrator threads', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-warm-thread-isolation-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
    const procs: FakeClaudeProc[] = [];
    spawnMock.mockImplementation(() => {
      const proc = new FakeClaudeProc();
      procs.push(proc);
      return proc as unknown as ChildProcess;
    });
    const firstSession = ensureOrchestratorSession(repoPath, `thoughts-carrier-a-${Date.now()}`);
    const secondSession = ensureOrchestratorSession(repoPath, `thoughts-carrier-b-${Date.now()}`);

    const firstTurn = sendToOrchestrator(firstSession, 'first thread', () => {});
    const secondTurn = sendToOrchestrator(secondSession, 'second thread', () => {});
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(procs[0]!.stdin.write).toHaveBeenCalledTimes(1);
      expect(procs[1]!.stdin.write).toHaveBeenCalledTimes(1);
    });
    const firstEnv = spawnMock.mock.calls[0]![2].env as NodeJS.ProcessEnv;
    const secondEnv = spawnMock.mock.calls[1]![2].env as NodeJS.ProcessEnv;
    expect(firstEnv.ANTHROPIC_AUTH_TOKEN).toBe('local-orchestrator-token');
    expect(secondEnv.ANTHROPIC_AUTH_TOKEN).toBe('local-orchestrator-token');
    expect(firstEnv.CLAUDE_CONFIG_DIR).not.toBe(secondEnv.CLAUDE_CONFIG_DIR);
    expect(firstSession.sessionName).not.toBe(secondSession.sessionName);
    expect(spawnMock.mock.calls[0]![1]).toContain('gpt-5.6-sol');
    expect(spawnMock.mock.calls[1]![1]).toContain('gpt-5.6-sol');

    procs[0]!.stdout.emit('data', Buffer.from('{"type":"result","session_id":"thread-a"}\n'));
    procs[1]!.stdout.emit('data', Buffer.from('{"type":"result","session_id":"thread-b"}\n'));
    await Promise.all([firstTurn, secondTurn]);

    const firstFollowup = sendToOrchestrator(firstSession, 'follow up a', () => {});
    const secondFollowup = sendToOrchestrator(secondSession, 'follow up b', () => {});
    await vi.waitFor(() => {
      expect(procs[0]!.stdin.write).toHaveBeenCalledTimes(2);
      expect(procs[1]!.stdin.write).toHaveBeenCalledTimes(2);
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    procs[0]!.stdout.emit('data', Buffer.from('{"type":"result","session_id":"thread-a"}\n'));
    procs[1]!.stdout.emit('data', Buffer.from('{"type":"result","session_id":"thread-b"}\n'));
    await Promise.all([firstFollowup, secondFollowup]);
    for (const proc of procs) {
      proc.exitCode = 0;
      proc.emit('close', 0);
    }
  });

  it('bakes a dispatch-free system prompt into a Solo resident process (#2898)', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-solo-prompt-launch-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
    const proc = new FakeClaudeProc();
    spawnMock.mockReturnValue(proc as unknown as ChildProcess);
    const session = ensureOrchestratorSession(repoPath, `thoughts-solo-prompt-${Date.now()}`);

    const turn = sendToOrchestrator(session, 'work directly', () => {}, { toolProfile: 'solo' });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalledOnce());

    const args = spawnMock.mock.calls[0]![1] as string[];
    const systemPrompt = args[args.indexOf('--append-system-prompt') + 1]!;
    expect(systemPrompt).toContain('Outcome, Evidence, Residual, and Decision');
    expect(systemPrompt).toContain('cortex_list_issues');
    expect(systemPrompt).not.toContain('cortex_launch_agent');
    expect(systemPrompt).not.toContain('create_mission');
    expect(systemPrompt).not.toContain('## ORCHESTRATOR PROTOCOL');

    proc.stdout.emit('data', Buffer.from('{"type":"result","session_id":"solo-prompt-session"}\n'));
    await turn;
    proc.exitCode = 0;
    proc.emit('close', 0);
  });

  it('resumes after deliberate kills, while reset and unexpected exit start fresh (#2909)', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-deliberate-resume-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
    const procs: FakeClaudeProc[] = [];
    spawnMock.mockImplementation(() => {
      const proc = new FakeClaudeProc();
      procs.push(proc);
      return proc as unknown as ChildProcess;
    });
    const threadId = `thoughts-deliberate-resume-${Date.now()}`;
    const session = ensureOrchestratorSession(repoPath, threadId);
    const complete = async (turn: Promise<void>, index: number, id: string) => {
      await vi.waitFor(() => expect(procs[index]!.stdin.write).toHaveBeenCalledOnce());
      procs[index]!.stdout.emit('data', Buffer.from(`{"type":"result","session_id":"${id}"}\n`));
      await turn;
    };
    const resumeArg = (index: number) => {
      const args = spawnMock.mock.calls[index]![1] as string[];
      return args[args.indexOf('--resume') + 1];
    };

    const timerSpy = vi.spyOn(global, 'setTimeout');
    await complete(sendToOrchestrator(session, 'first', () => {}), 0, 'deliberate-session');
    const idleCallback = timerSpy.mock.calls.find(([, delay]) => delay === 30 * 60_000)?.[0];
    timerSpy.mockRestore();
    expect(idleCallback).toBeTypeOf('function');
    idleCallback?.();
    expect(session.status).toBe('dead');
    await complete(sendToOrchestrator(session, 'after idle reap', () => {}), 1, 'deliberate-session');
    expect(resumeArg(1)).toBe('deliberate-session');

    reloadOrchestratorSession(repoPath, threadId);
    expect(session.status).toBe('dead');
    await complete(sendToOrchestrator(session, 'after reload', () => {}), 2, 'deliberate-session');
    expect(resumeArg(2)).toBe('deliberate-session');

    const controller = new AbortController();
    const interrupted = sendToOrchestrator(session, 'interrupt this', () => {}, { signal: controller.signal });
    await vi.waitFor(() => expect(procs[2]!.stdin.write).toHaveBeenCalledTimes(2));
    controller.abort();
    await interrupted;
    expect(session.status).toBe('dead');
    await complete(sendToOrchestrator(session, 'after interrupt', () => {}), 3, 'deliberate-session');
    expect(resumeArg(3)).toBe('deliberate-session');

    requestOrchestratorSessionReset(repoPath, threadId);
    await complete(sendToOrchestrator(session, 'after reset', () => {}), 4, 'fresh-session');
    expect((spawnMock.mock.calls[4]![1] as string[])).not.toContain('--resume');

    procs[4]!.exitCode = 1;
    procs[4]!.emit('close', 1);
    expect(session.status).toBe('dead');
    await complete(sendToOrchestrator(session, 'after crash', () => {}), 5, 'post-crash-session');
    expect((spawnMock.mock.calls[5]![1] as string[])).not.toContain('--resume');
    procs[5]!.exitCode = 0;
    procs[5]!.emit('close', 0);
  });

  it('retries once with a fresh session when Claude cannot load the resumed one (#2909)', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-missing-resume-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
    const threadId = `thoughts-missing-resume-${Date.now()}`;
    const procs: FakeClaudeProc[] = [];
    spawnMock.mockImplementation(() => {
      const proc = new FakeClaudeProc();
      procs.push(proc);
      return proc as unknown as ChildProcess;
    });
    const session = ensureOrchestratorSession(repoPath, threadId);
    const first = sendToOrchestrator(session, 'first', () => {});
    await vi.waitFor(() => expect(procs[0]!.stdin.write).toHaveBeenCalledOnce());
    procs[0]!.stdout.emit('data', Buffer.from('{"type":"result","session_id":"missing-resume"}\n'));
    await first;
    writeOrchestratorBackendSessionId(threadId, 'claude', 'missing-resume');
    reloadOrchestratorSession(repoPath, threadId);

    const events: OrchestratorEvent[] = [];
    const turn = sendToOrchestrator(session, 'continue the work', (event) => events.push(event), { toolProfile: 'solo' });
    await vi.waitFor(() => expect(procs[1]!.stdin.write).toHaveBeenCalledOnce());
    expect((spawnMock.mock.calls[1]![1] as string[])).toContain('--resume');
    expect(writtenTurnText(procs[1]!, 0)).toContain('<o8_orchestrator_prompt>');
    procs[1]!.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'result', subtype: 'error_during_execution', is_error: true,
      session_id: 'missing-resume', errors: ['No conversation found with session ID: missing-resume'],
    }) + '\n'));
    await vi.waitFor(() => expect(procs[2]!.stdin.write).toHaveBeenCalledOnce());
    expect((spawnMock.mock.calls[2]![1] as string[])).not.toContain('--resume');
    expect(writtenTurnText(procs[2]!, 0)).toBe('continue the work');
    expect(readOrchestratorBackendSessionId(threadId, 'claude')).toBeNull();
    expect(events.some((event) => event.type === 'turn_retry' && event.reason === 'resume-unavailable')).toBe(true);
    procs[2]!.stdout.emit('data', Buffer.from('{"type":"result","session_id":"fresh-session"}\n'));
    await turn;
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    procs[2]!.exitCode = 0;
    procs[2]!.emit('close', 0);
  });

  it('gives a resumed session the current prompt after a tool-profile change (#2904)', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-resume-prompt-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
    const procs: FakeClaudeProc[] = [];
    spawnMock.mockImplementation(() => {
      const proc = new FakeClaudeProc();
      procs.push(proc);
      return proc as unknown as ChildProcess;
    });
    const session = ensureOrchestratorSession(repoPath, `thoughts-resume-prompt-${Date.now()}`);

    const fleetTurn = sendToOrchestrator(session, 'plan the work', () => {});
    await vi.waitFor(() => expect(procs[0]?.stdin.write).toHaveBeenCalledOnce());
    const fleetArgs = spawnMock.mock.calls[0]![1] as string[];
    expect(fleetArgs[fleetArgs.indexOf('--append-system-prompt') + 1]).toContain('cortex_launch_agent');
    expect(writtenTurnText(procs[0]!, 0)).toBe('plan the work');
    procs[0]!.stdout.emit('data', Buffer.from('{"type":"result","session_id":"resume-prompt-session"}\n'));
    await fleetTurn;

    // Fleet -> Solo recycles the resident process; the respawn resumes the
    // session, whose system prompt Claude Code keeps from the first launch.
    const soloTurn = sendToOrchestrator(session, 'work directly', () => {}, { toolProfile: 'solo' });
    await vi.waitFor(() => expect(procs[1]?.stdin.write).toHaveBeenCalledOnce());
    const soloArgs = spawnMock.mock.calls[1]![1] as string[];
    expect(soloArgs.slice(soloArgs.indexOf('--resume'), soloArgs.indexOf('--resume') + 2))
      .toEqual(['--resume', 'resume-prompt-session']);
    const refreshed = writtenTurnText(procs[1]!, 0);
    const block = refreshed.slice(refreshed.indexOf('<o8_orchestrator_prompt>'), refreshed.indexOf('</o8_orchestrator_prompt>'));
    expect(block).toContain('Outcome, Evidence, Residual, and Decision');
    expect(block).not.toContain('cortex_launch_agent');
    expect(block).not.toContain('create_mission');
    expect(refreshed.endsWith('Operator message:\nwork directly')).toBe(true);
    procs[1]!.stdout.emit('data', Buffer.from('{"type":"result","session_id":"resume-prompt-session"}\n'));
    await soloTurn;

    // The session now holds the Solo prompt, so the next Solo turn is plain.
    const nextSoloTurn = sendToOrchestrator(session, 'keep going', () => {}, { toolProfile: 'solo' });
    await vi.waitFor(() => expect(procs[1]!.stdin.write).toHaveBeenCalledTimes(2));
    expect(writtenTurnText(procs[1]!, 1)).toBe('keep going');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    procs[1]!.stdout.emit('data', Buffer.from('{"type":"result","session_id":"resume-prompt-session"}\n'));
    await nextSoloTurn;
    procs[1]!.exitCode = 0;
    procs[1]!.emit('close', 0);
  });

  it('gives a persisted session with no prompt record the current prompt once (#2904)', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-legacy-resume-prompt-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
    const threadId = `thoughts-legacy-resume-${Date.now()}`;
    writeOrchestratorBackendSessionId(threadId, 'claude', 'legacy-claude-session');
    const proc = new FakeClaudeProc();
    spawnMock.mockReturnValue(proc as unknown as ChildProcess);
    const session = ensureOrchestratorSession(repoPath, threadId);
    expect(session.claudeSessionId).toBe('legacy-claude-session');

    const firstTurn = sendToOrchestrator(session, 'after the upgrade', () => {}, { toolProfile: 'solo' });
    await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalledOnce());
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain('--resume');
    expect(args).not.toContain('--append-system-prompt');
    expect(writtenTurnText(proc, 0)).toContain('<o8_orchestrator_prompt>');
    proc.stdout.emit('data', Buffer.from('{"type":"result","session_id":"legacy-claude-session"}\n'));
    await firstTurn;

    const secondTurn = sendToOrchestrator(session, 'next', () => {}, { toolProfile: 'solo' });
    await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalledTimes(2));
    expect(writtenTurnText(proc, 1)).toBe('next');
    proc.stdout.emit('data', Buffer.from('{"type":"result","session_id":"legacy-claude-session"}\n'));
    await secondTurn;
    proc.exitCode = 0;
    proc.emit('close', 0);
  });

  it.each([
    ['an is_error result', { type: 'result', subtype: 'success', is_error: true, result: 'provider failed' }],
    ['an error subtype result', { type: 'result', subtype: 'error_during_execution', is_error: false, result: 'provider failed' }],
  ])('keeps the current prompt pending after %s (#2904)', async (_label, failedResult) => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-failed-resume-prompt-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
    const uniqueId = `${Date.now()}-${Math.random()}`;
    const threadId = `thoughts-failed-resume-${uniqueId}`;
    const claudeSessionId = `failed-resume-session-${uniqueId}`;
    writeOrchestratorBackendSessionId(threadId, 'claude', claudeSessionId);
    const proc = new FakeClaudeProc();
    spawnMock.mockReturnValue(proc as unknown as ChildProcess);
    const session = ensureOrchestratorSession(repoPath, threadId);

    const failedTurn = sendToOrchestrator(session, 'try the current prompt', () => {}, { toolProfile: 'solo' });
    await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalledOnce());
    expect(writtenTurnText(proc, 0)).toContain('<o8_orchestrator_prompt>');
    proc.stdout.emit('data', Buffer.from(`${JSON.stringify({ ...failedResult, session_id: claudeSessionId })}\n`));
    await failedTurn;
    expect(readDeliveredOrchestratorPrompt(claudeSessionId)).toBeNull();

    const retryTurn = sendToOrchestrator(session, 'retry the current prompt', () => {}, { toolProfile: 'solo' });
    await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalledTimes(2));
    expect(writtenTurnText(proc, 1)).toContain('<o8_orchestrator_prompt>');
    proc.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: claudeSessionId })}\n`));
    await retryTurn;
    expect(readDeliveredOrchestratorPrompt(claudeSessionId)).not.toBeNull();

    const acknowledgedTurn = sendToOrchestrator(session, 'continue', () => {}, { toolProfile: 'solo' });
    await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalledTimes(3));
    expect(writtenTurnText(proc, 2)).toBe('continue');
    proc.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: claudeSessionId })}\n`));
    await acknowledgedTurn;
    proc.exitCode = 0;
    proc.emit('close', 0);
  });

  it('carries an explicitly selected API model through the real orchestrator launch path', async () => {
    carrierState.source = 'openrouter';
    carrierState.model = 'provider/frontier-model';
    carrierState.baseUrl = 'https://gateway.example/api';
    carrierState.token = 'api-carrier-token';
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-api-carrier-launch-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
    const proc = new FakeClaudeProc();
    spawnMock.mockReturnValue(proc as unknown as ChildProcess);
    const session = ensureOrchestratorSession(repoPath, `thoughts-api-carrier-${Date.now()}`);

    const turn = sendToOrchestrator(session, 'run through the selected carrier', () => {});
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalledOnce());

    const args = spawnMock.mock.calls[0]![1] as string[];
    const env = spawnMock.mock.calls[0]![2].env as NodeJS.ProcessEnv;
    expect(args).toContain('provider/frontier-model');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.example/api');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('api-carrier-token');

    proc.stdout.emit('data', Buffer.from('{"type":"result","session_id":"api-carrier-session"}\n'));
    await turn;
    proc.exitCode = 0;
    proc.emit('close', 0);
  });
});
