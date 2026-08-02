import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const resolveDefaultWorkerEffortSyncMock = vi.hoisted(() => vi.fn((runtime, explicitEffort) => explicitEffort ?? undefined));
const ensureDispatchBackendReadyMock = vi.hoisted(() => vi.fn(async () => ({
  ready: true,
  reason: 'http_200',
  waitedMs: 0,
  attempts: 1,
})));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return {
    ...actual,
    ensureDispatchBackendReady: ensureDispatchBackendReadyMock,
  };
});

vi.mock('@/lib/operator/defaults', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/operator/defaults')>();
  return {
    ...actual,
    resolveDefaultWorkerEffortSync: resolveDefaultWorkerEffortSyncMock,
  };
});

describe('Claude Code dispatch spawn', () => {
  let tempRoot: string;
  let repoPath: string;
  let priorOwnedRoot: string | undefined;
  let priorClaudeBin: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    tempRoot = mkdtempSync(path.join(process.env.CORTEX_IDE_DATA_DIR!, 'claude-dispatch-'));
    repoPath = path.join(tempRoot, 'repo');
    execFileSync('git', ['init', '-q', repoPath]);
    priorOwnedRoot = process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT;
    priorClaudeBin = process.env.O8_CLAUDE_CODE_BIN;
    process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = path.join(tempRoot, 'owned');
    process.env.O8_CLAUDE_CODE_BIN = process.execPath;
    spawnMock.mockReturnValue({
      pid: 42,
      stdin: { end: vi.fn() },
      unref: vi.fn(),
      once: vi.fn(),
    });
    ensureDispatchBackendReadyMock.mockClear();
    resolveDefaultWorkerEffortSyncMock.mockImplementation((runtime, explicitEffort) => explicitEffort ?? undefined);
  });

  afterEach(() => {
    spawnMock.mockReset();
    resolveDefaultWorkerEffortSyncMock.mockReset();
    if (priorOwnedRoot === undefined) delete process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT;
    else process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = priorOwnedRoot;
    if (priorClaudeBin === undefined) delete process.env.O8_CLAUDE_CODE_BIN;
    else process.env.O8_CLAUDE_CODE_BIN = priorClaudeBin;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('launches a dispatched worker as stream-json without print flags in the packet worktree cwd', async () => {
    const { claudeCodeRuntime } = await import('@/lib/runtimes/claude-code');
    const result = await claudeCodeRuntime.launch({
      cwd: repoPath,
      prompt: 'implement the packet',
      model: 'claude-sonnet-4-5',
      laneId: 'lane-claude',
    });

    expect(result.ok).toBe(true);
    expect(ensureDispatchBackendReadyMock).toHaveBeenCalledWith('claude-code', 'launch');
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [command, args, options] = spawnMock.mock.calls[0]!;
    expect(command).toBe(process.platform === 'win32' ? process.execPath : 'nice');
    const argv = process.platform === 'win32' ? args : args.slice(2);
    expect(argv).toEqual([
      process.execPath,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--include-partial-messages',
      '--model',
      'claude-sonnet-4-5',
    ]);
    expect(argv).not.toContain('-p');
    expect(argv).not.toContain('--print');
    expect(options.cwd).toBe(realpathSync(repoPath));
    expect(spawnMock.mock.results[0]?.value.stdin.end).toHaveBeenCalledWith(
      expect.stringContaining('implement the packet'),
      'utf8',
    );
  }, 20_000);

  it('passes the requested Claude model and effort to the stream-json launch argv', async () => {
    const { claudeCodeRuntime } = await import('@/lib/runtimes/claude-code');
    const result = await claudeCodeRuntime.launch({
      cwd: repoPath,
      prompt: 'implement the packet',
      model: 'claude-opus-4-8',
      effort: 'high',
      laneId: 'lane-claude',
    });

    expect(result.ok).toBe(true);
    expect(resolveDefaultWorkerEffortSyncMock).toHaveBeenCalledWith('claude-code', 'high');
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [, args] = spawnMock.mock.calls[0]!;
    const argv = process.platform === 'win32' ? args : args.slice(2);
    expect(argv).toEqual([
      process.execPath,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--include-partial-messages',
      '--model',
      'claude-opus-4-8',
      '--effort',
      'high',
    ]);
    expect(argv).not.toContain('-p');
    expect(argv).not.toContain('--print');
  }, 20_000);

  it('applies the default Claude worker effort when launch omits effort', async () => {
    resolveDefaultWorkerEffortSyncMock.mockReturnValue('max');
    const { claudeCodeRuntime } = await import('@/lib/runtimes/claude-code');
    const result = await claudeCodeRuntime.launch({
      cwd: repoPath,
      prompt: 'implement the packet',
      model: 'claude-opus-4-8',
      laneId: 'lane-claude',
    });

    expect(result.ok).toBe(true);
    expect(resolveDefaultWorkerEffortSyncMock).toHaveBeenCalledWith('claude-code', undefined);

    const [, args] = spawnMock.mock.calls[0]!;
    const argv = process.platform === 'win32' ? args : args.slice(2);
    expect(argv).toContain('--effort');
    expect(argv).toContain('max');
  }, 20_000);

  it('omits the Claude effort flag for adaptive effort', async () => {
    const { claudeCodeRuntime } = await import('@/lib/runtimes/claude-code');
    const result = await claudeCodeRuntime.launch({
      cwd: repoPath,
      prompt: 'implement the packet',
      model: 'claude-opus-4-8',
      effort: 'adaptive',
      laneId: 'lane-claude',
    });

    expect(result.ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [, args] = spawnMock.mock.calls[0]!;
    const argv = process.platform === 'win32' ? args : args.slice(2);
    expect(argv).toContain('--model');
    expect(argv).toContain('claude-opus-4-8');
    expect(argv).not.toContain('--effort');
    expect(argv).not.toContain('-p');
    expect(argv).not.toContain('--print');
  }, 20_000);
});
