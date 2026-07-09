import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({
  CliNotFoundError: class CliNotFoundError extends Error {},
  resolveCli: vi.fn(async () => {
    throw new Error('missing');
  }),
}));

describe('piRuntime discovery', () => {
  it('returns empty gracefully when the pi binary is absent', async () => {
    const { piRuntime } = await import('./pi');
    await expect(piRuntime.discoverSessions()).resolves.toEqual([]);
  });
});
