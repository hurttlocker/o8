import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-cost-persistence-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { getDb, usageLogs } = await import('@/lib/db');
const { persistSessionCost } = await import('./cost-persistence');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('runtime cost persistence', () => {
  it('persists OpenCode 2 telemetry under its own provider instead of dropping it', async () => {
    await expect(persistSessionCost({
      sessionKey: 'opencode-owned:cost-test',
      runtime: 'opencode',
      model: 'opencode/deepseek-v4-flash-free',
      inputTokens: 120,
      outputTokens: 30,
      costUsd: 0,
      repoPath: '/tmp/o8-cost-test-repo',
    })).resolves.toBe(true);

    expect(getDb()?.select().from(usageLogs).all()).toContainEqual(expect.objectContaining({
      sessionKey: 'opencode-owned:cost-test',
      provider: 'opencode',
      inputTokens: 120,
      outputTokens: 30,
    }));
  });
});
