import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-review-card-pr-only-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const lanesRoute = await import('@/app/api/lanes/route');
const { createLane } = await import('@/lib/lane/registry');
const { DOGFOOD_PR_ONLY_NOTE } = await import('@/lib/lane/merge-mode');

function lanesReq() {
  return new NextRequest('http://localhost:3001/api/lanes?active=false', {
    method: 'GET',
    headers: { host: 'localhost:3001' },
  });
}

describe('review card PR-only mode reaches the lane-list route', () => {
  it('stamps PR-only merge policy on real /api/lanes rows before UI actions render', async () => {
    const sentinelPath = join(dataDir, '.dogfood-pr-only');
    rmSync(sentinelPath, { force: true });
    const lane = createLane({
      repoPath: '/tmp/o8-review-card-pr-only-repo',
      branch: 'issue/pr-only-card',
      runtime: 'codex',
      label: 'Review card PR-only lane',
      packetId: 'pkt-review-card-pr-only',
    });

    writeFileSync(sentinelPath, '', 'utf-8');
    try {
      const response = await lanesRoute.GET(lanesReq());
      expect(response.status).toBe(200);
      const payload = await response.json() as {
        lanes?: Array<{ id: string; mergeMode?: string; mergeModeNote?: string | null }>;
      };
      const row = payload.lanes?.find((candidate) => candidate.id === lane.id);

      expect(row).toBeTruthy();
      expect(row?.mergeMode).toBe('pr_only');
      expect(row?.mergeModeNote).toBe(DOGFOOD_PR_ONLY_NOTE);
    } finally {
      rmSync(sentinelPath, { force: true });
    }
  });
});
