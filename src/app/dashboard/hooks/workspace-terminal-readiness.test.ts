import { describe, expect, it, vi } from 'vitest';
import { waitForWorkspaceTerminalHandle } from './workspace-terminal-readiness';

describe('waitForWorkspaceTerminalHandle', () => {
  it('observes a handle registered after the workspace tile is scheduled', async () => {
    const handle = { id: 'terminal-handle' };
    let current: typeof handle | null = null;
    const wait = vi.fn(async () => {
      current = handle;
    });

    await expect(waitForWorkspaceTerminalHandle({
      read: () => current,
      wait,
      attempts: 3,
      intervalMs: 10,
    })).resolves.toBe(handle);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(10);
  });

  it('returns null at the bounded deadline', async () => {
    const wait = vi.fn(async () => {});

    await expect(waitForWorkspaceTerminalHandle({
      read: () => null,
      wait,
      attempts: 3,
      intervalMs: 10,
    })).resolves.toBeNull();
    expect(wait).toHaveBeenCalledTimes(2);
  });
});
