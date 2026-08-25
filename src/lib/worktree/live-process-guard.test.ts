import { describe, expect, it } from 'vitest';

import { hasLiveProcessInside, probeLiveProcessInside } from './live-process-guard';

describe('live-process guard lsof taxonomy', () => {
  it('filters one machine-wide cwd snapshot without recursively scanning the tree', async () => {
    const readSnapshot = async () => ({
      status: 'ready' as const,
      capturedAt: Date.now(),
      rows: [{ pid: 42, cwd: '/tmp/another-tree', commandName: 'node' }],
    });

    await expect(hasLiveProcessInside('/tmp/worktree', { readSnapshot })).resolves.toBe(false);
  });

  it('fails closed when the machine-wide snapshot is unavailable', async () => {
    const readSnapshot = async () => ({
      status: 'unavailable' as const,
      capturedAt: Date.now(),
      rows: [] as [],
      reason: 'permission denied',
    });

    await expect(hasLiveProcessInside('/tmp/worktree', { readSnapshot })).resolves.toBe(true);
    await expect(probeLiveProcessInside('/tmp/worktree', { readSnapshot })).resolves.toMatchObject({
      status: 'inconclusive',
      reason: expect.stringContaining('permission denied'),
    });
  });

  it('detects a process cwd nested anywhere under the worktree', async () => {
    const readSnapshot = async () => ({
      status: 'ready' as const,
      capturedAt: Date.now(),
      rows: [{ pid: 77, cwd: '/tmp/worktree/packages/app', commandName: 'node' }],
    });

    await expect(probeLiveProcessInside('/tmp/worktree', { readSnapshot })).resolves.toEqual({
      status: 'live',
      pids: ['77'],
    });
  });
});
