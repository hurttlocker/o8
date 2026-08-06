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
      throw new CliNotFoundError('prime-agent', ['which:prime-agent']);
    }),
  };
});

describe('prime-agent runtime discovery', () => {
  it('returns [] when the prime-agent binary is absent', { timeout: 20_000 }, async () => {
    const { primeAgentRuntime } = await import('./prime-agent');
    await expect(primeAgentRuntime.discoverSessions()).resolves.toEqual([]);
  });
});
