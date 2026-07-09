import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/runtimes/shared/cli-resolver', () => {
  class CliNotFoundError extends Error {
    readonly triedPaths: string[];
    constructor(binaryName: string, triedPaths: string[]) {
      super(`${binaryName} not found`);
      this.name = 'CliNotFoundError';
      this.triedPaths = triedPaths;
    }
  }
  return {
    CliNotFoundError,
    resolveCli: vi.fn(async () => {
      throw new CliNotFoundError('cursor-agent', ['which:cursor-agent']);
    }),
  };
});

describe('cursor runtime discovery', () => {
  it('returns [] when cursor-agent is absent', async () => {
    const { cursorRuntime } = await import('./cursor');
    await expect(cursorRuntime.discoverSessions()).resolves.toEqual([]);
  });
});
