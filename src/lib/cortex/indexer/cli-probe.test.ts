import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/operator/brain-routing', () => ({
  resolveBrainUseClaudeCliSync: vi.fn(),
  resolveBrainUseCodexCliSync: vi.fn(),
}));

import { probeIndexerCli, resetIndexerCliCache } from './cli-probe';
import { resolveBrainUseClaudeCliSync, resolveBrainUseCodexCliSync } from '@/lib/operator/brain-routing';

describe('Brain indexer subscription routing', () => {
  beforeEach(() => {
    resetIndexerCliCache();
    delete process.env.O8_INDEXER_CLI;
    process.env.O8_CLAUDE_CODE_BIN = process.execPath;
    process.env.O8_CODEX_BIN = process.execPath;
  });

  it('changes the cached provider when the active subscription profile changes', async () => {
    vi.mocked(resolveBrainUseClaudeCliSync).mockReturnValue(false);
    vi.mocked(resolveBrainUseCodexCliSync).mockReturnValue(true);
    await expect(probeIndexerCli()).resolves.toBe('codex');

    vi.mocked(resolveBrainUseClaudeCliSync).mockReturnValue(true);
    vi.mocked(resolveBrainUseCodexCliSync).mockReturnValue(false);
    await expect(probeIndexerCli()).resolves.toBe('claude');
  });

  it('refuses an explicit provider disabled by the subscription profile', async () => {
    vi.mocked(resolveBrainUseClaudeCliSync).mockReturnValue(true);
    vi.mocked(resolveBrainUseCodexCliSync).mockReturnValue(false);
    process.env.O8_INDEXER_CLI = 'codex';

    await expect(probeIndexerCli()).resolves.toBeNull();
  });
});
