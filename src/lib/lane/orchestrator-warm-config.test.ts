import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const configState = vi.hoisted(() => ({ reversed: false }));
const resolveCarrierMock = vi.hoisted(() => vi.fn(async ({ sessionDir }: { sessionDir: string }) => ({
  source: 'codex-subscription' as const,
  model: 'gpt-5.6-sol',
  spawnEnv: {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317',
    ANTHROPIC_AUTH_TOKEN: 'local-orchestrator-token',
    CLAUDE_CONFIG_DIR: `${sessionDir}/claude-code-codex-config`,
  },
  fingerprint: `codex:${sessionDir}`,
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

const { ensureOrchestratorSession, sendToOrchestrator } = await import('./orchestrator-session');

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
});
