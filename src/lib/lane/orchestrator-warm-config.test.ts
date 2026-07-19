import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const configState = vi.hoisted(() => ({ reversed: false }));

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
    expect(spawnMock).toHaveBeenCalledTimes(1);
    procs[0]!.stdout.emit('data', Buffer.from('{"type":"result","session_id":"warm-session"}\n'));
    await firstTurn;

    configState.reversed = true;
    const secondTurn = sendToOrchestrator(session, 'second', () => {});
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(procs[0]!.kill).not.toHaveBeenCalled();
    procs[0]!.stdout.emit('data', Buffer.from('{"type":"result","session_id":"warm-session"}\n'));
    await secondTurn;
    procs[0]!.exitCode = 0;
    procs[0]!.emit('close', 0);
  });
});
