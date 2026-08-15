import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const { listReposMock } = vi.hoisted(() => ({ listReposMock: vi.fn() }));

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/repos/registry', () => ({ listRepos: listReposMock }));

import { GET } from '@/app/api/worktrees/retention-usage/route';
import { resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';

describe('worktree retention usage real route path', () => {
  let testRoot = '';
  let previousWorktreeRoot: string | undefined;

  beforeEach(async () => {
    previousWorktreeRoot = process.env.O8_WORKTREE_ROOT;
    testRoot = await mkdtemp(path.join(os.tmpdir(), 'o8-storage-telemetry-'));
    process.env.O8_WORKTREE_ROOT = path.join(testRoot, 'worktree-root');
    listReposMock.mockReset();
  });

  afterEach(async () => {
    if (previousWorktreeRoot === undefined) delete process.env.O8_WORKTREE_ROOT;
    else process.env.O8_WORKTREE_ROOT = previousWorktreeRoot;
    if (testRoot) await rm(testRoot, { recursive: true, force: true });
  });

  it('measures allocated and apparent bytes plus the hosting volume through the GET route', async () => {
    const repoRoot = path.join(testRoot, 'repo');
    await mkdir(repoRoot, { recursive: true });
    listReposMock.mockResolvedValue([{
      id: 'repo-real',
      name: 'real-repo',
      localPath: repoRoot,
    }]);
    const layout = resolveWorktreeRootLayout(repoRoot);
    await Promise.all([
      mkdir(path.join(layout.primaryBase, 'packet-a'), { recursive: true }),
      mkdir(path.join(layout.primaryBase, 'packet-b'), { recursive: true }),
      mkdir(path.join(layout.primaryBase, '.metadata'), { recursive: true }),
    ]);
    await writeFile(path.join(layout.primaryBase, 'packet-a', 'source.bin'), Buffer.alloc(2_048));
    await writeFile(path.join(layout.primaryBase, 'packet-b', 'source.bin'), Buffer.alloc(4_096));
    const sparseFile = await open(path.join(layout.primaryBase, 'packet-b', 'sparse.bin'), 'w');
    await sparseFile.truncate(8 * 1024 * 1024);
    await sparseFile.close();

    const response = await GET(new NextRequest(
      'http://127.0.0.1/api/worktrees/retention-usage',
    ));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      schema: 'o8/worktree-storage-telemetry/v1',
      accountingStatus: 'observed',
      totalCount: 2,
      unknownCountMeasurements: 0,
      unknownAllocatedByteMeasurements: 0,
      unknownLogicalByteMeasurements: 0,
      hostAccountingStatus: 'observed',
      repos: [{
        id: 'repo-real',
        path: layout.primaryBase,
        count: 2,
        accountingStatus: 'observed',
      }],
    });
    expect(payload.totalAllocatedBytes).toBeGreaterThan(0);
    expect(payload.totalLogicalBytes).toBeGreaterThan(0);
    expect(payload.totalBytes).toBe(payload.totalAllocatedBytes);
    expect(payload.totalLogicalBytes).toBeGreaterThan(payload.totalAllocatedBytes);
    expect(payload.repos[0].bytes).toBe(payload.repos[0].allocatedBytes);
    expect(payload.repos[0].logicalBytes).toBeGreaterThan(payload.repos[0].allocatedBytes);
    expect(payload.hostFreeBytes).toBeGreaterThan(0);
    expect(payload.hostAvailableBytes).toBeGreaterThan(0);
    expect(payload.hostTotalBytes).toBeGreaterThan(payload.hostFreeBytes);
  });
});
