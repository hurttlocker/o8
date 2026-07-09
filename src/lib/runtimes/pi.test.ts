import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({
  CliNotFoundError: class CliNotFoundError extends Error {},
  resolveCli: vi.fn(async () => {
    throw new Error('missing');
  }),
}));

describe('piRuntime discovery', () => {
  // 20s: the dynamic import pulls the runtime's full module graph, which on a
  // loaded machine hovers right at vitest's 5s default (5.06s observed) — the
  // same borderline-timeout class dfd457df fixed for the real-child/DB tests.
  it('returns empty gracefully when the pi binary is absent', { timeout: 20_000 }, async () => {
    const { piRuntime } = await import('./pi');
    await expect(piRuntime.discoverSessions()).resolves.toEqual([]);
  });
});
