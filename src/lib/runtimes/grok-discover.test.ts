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
      throw new CliNotFoundError('grok', ['which:grok']);
    }),
  };
});

describe('grok runtime discovery', () => {
  it('returns [] when grok is absent', { timeout: 20_000 }, async () => {
    const { grokRuntime } = await import('./grok');
    await expect(grokRuntime.discoverSessions()).resolves.toEqual([]);
  });
});
