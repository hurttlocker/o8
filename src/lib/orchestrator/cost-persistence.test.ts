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

  it('persists telemetry-capable runtimes through the provider-neutral receipt path', async () => {
    await expect(persistSessionCost({
      sessionKey: 'pi-owned:cost-test',
      runtime: 'pi',
      model: 'provider/model',
      inputTokens: 42,
      outputTokens: 9,
      costUsd: 0.12,
      repoPath: '/tmp/o8-cost-test-repo',
    })).resolves.toBe(true);

    expect(getDb()?.select().from(usageLogs).all()).toContainEqual(expect.objectContaining({
      sessionKey: 'pi-owned:cost-test',
      provider: 'runtime',
      inputTokens: 42,
      outputTokens: 9,
    }));
  });

  it('updates one session receipt monotonically after a resumed turn', async () => {
    const base = {
      sessionKey: 'cursor-owned:resumed-cost',
      runtime: 'cursor',
      model: 'provider/model',
      repoPath: '/tmp/o8-cost-test-repo',
    };
    await persistSessionCost({ ...base, inputTokens: 100, outputTokens: 20, costUsd: 0.1 });
    await persistSessionCost({ ...base, inputTokens: 250, outputTokens: 70, costUsd: 0.3 });
    await persistSessionCost({ ...base, inputTokens: 200, outputTokens: 60, costUsd: 0.2 });

    const rows = getDb()?.select().from(usageLogs).all()
      .filter((row) => row.sessionKey === base.sessionKey);
    expect(rows).toEqual([expect.objectContaining({
      provider: 'runtime',
      inputTokens: 250,
      outputTokens: 70,
      costUsd: 0.3,
    })]);
  });
});
