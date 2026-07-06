import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
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

describe('Claude Code dispatch spawn', () => {
  let tempRoot: string;
  let repoPath: string;
  let priorOwnedRoot: string | undefined;
  let priorClaudeBin: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.homedir(), '.o8-claude-dispatch-'));
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
    });
    ensureDispatchBackendReadyMock.mockClear();
  });

  afterEach(() => {
    spawnMock.mockReset();
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
    expect(options.cwd).toBe(repoPath);
    expect(spawnMock.mock.results[0]?.value.stdin.end).toHaveBeenCalledWith(
      expect.stringContaining('implement the packet'),
      'utf8',
    );
  }, 20_000);
});
