import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-retention-admission-target-'));
const dataDir = path.join(fixtureRoot, 'data');
const managedRoot = path.join(fixtureRoot, 'managed');
const repoA = path.join(fixtureRoot, 'repo-a');
const repoB = path.join(fixtureRoot, 'repo-b');
for (const target of [dataDir, managedRoot, repoA, repoB]) mkdirSync(target);

const priorEnv = {
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_WORKTREE_ROOT: process.env.O8_WORKTREE_ROOT,
};
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = managedRoot;

const {
  hostTargets,
  listReposMock,
  readCategoryMock,
} = vi.hoisted(() => ({
  hostTargets: [] as string[],
  listReposMock: vi.fn(),
  readCategoryMock: vi.fn(),
}));

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/repos/registry', () => ({ listRepos: listReposMock }));
vi.mock('@/lib/orchestrator/storage-pressure-policy', () => ({
  projectStoragePressurePolicy: () => ({
    mode: 'manual',
    automaticParkingEnabled: false,
    eligibleRepositories: 2,
    optedOutRepositories: 0,
  }),
}));
vi.mock('@/lib/worktree/snapshot-state', () => ({
  countWorkspaceSnapshotsByState: () => 0,
}));
vi.mock('@/lib/worktree/storage-categories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/worktree/storage-categories')>();
  return { ...actual, readStorageCategorySnapshot: readCategoryMock };
});
vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>();
  return {
    ...actual,
    measureHostVolume: vi.fn(async (targetPath: string) => {
      const resolved = path.resolve(targetPath);
      hostTargets.push(resolved);
      const repositoryCheckout = resolved === realpathSync.native(repoA)
        || resolved === realpathSync.native(repoB);
      const canonicalManagedRoot = realpathSync.native(managedRoot);
      return {
        accountingStatus: 'observed' as const,
        targetPath: resolved,
        probePath: resolved.startsWith(`${canonicalManagedRoot}/`)
          ? canonicalManagedRoot
          : realpathSync.native(fixtureRoot),
        volumeId: repositoryCheckout ? 'device:repo' : 'device:managed',
        freeBytes: repositoryCheckout ? 900 : 400,
        availableBytes: repositoryCheckout ? 800 : 300,
        totalBytes: repositoryCheckout ? 2_000 : 1_000,
        error: null,
      };
    }),
  };
});

const { GET } = await import('./route');

function zeroCategory(category: 'source' | 'dependency' | 'build' | 'runtime' | 'transcript') {
  return {
    category,
    measurementMethod: 'known-path-sum',
    accountingStatus: 'observed',
    allocatedBytes: 0,
    logicalBytes: 0,
    observedAllocatedBytes: 0,
    observedLogicalBytes: 0,
    unknownAllocatedByteMeasurements: 0,
    unknownLogicalByteMeasurements: 0,
    errors: [],
  };
}

function absentWorkspace(target: string) {
  return {
    path: target,
    category: 'workspace',
    presence: 'absent',
    count: 0,
    allocatedBytes: 0,
    logicalBytes: 0,
    countAccounting: 'observed',
    allocatedBytesAccounting: 'observed',
    logicalBytesAccounting: 'observed',
    errors: [],
  };
}

describe('retention usage admission target selection', () => {
  beforeEach(() => {
    hostTargets.length = 0;
    process.env.O8_WORKTREE_ROOT = managedRoot;
    listReposMock.mockReset().mockResolvedValue([
      { id: 'repo-a', name: 'A', localPath: repoA, storagePressureParkingDisabled: false },
      { id: 'repo-b', name: 'B', localPath: repoB, storagePressureParkingDisabled: false },
    ]);
    const categories = {
      source: zeroCategory('source'),
      dependency: zeroCategory('dependency'),
      build: zeroCategory('build'),
      runtime: zeroCategory('runtime'),
      transcript: zeroCategory('transcript'),
    };
    readCategoryMock.mockReset().mockResolvedValue({
      schema: 'o8/storage-category-telemetry/v1',
      measuredAt: '2026-08-15T00:00:00.000Z',
      accountingStatus: 'observed',
      freshness: { source: 'measured', ageMs: 0, ttlMs: 5_000 },
      categories,
      repos: [
        {
          repositoryUuid: 'repo-a',
          workspaceMeasurements: [absentWorkspace(path.join(repoA, '.cortex-worktrees'))],
          categories,
        },
        {
          repositoryUuid: 'repo-b',
          workspaceMeasurements: [absentWorkspace(path.join(repoB, '.cortex-worktrees'))],
          categories,
        },
      ],
    });
  });

  it('projects managed worktree targets and counts a shared volume once', async () => {
    const response = await GET(new NextRequest('http://127.0.0.1/api/worktrees/retention-usage'));
    const payload = await response.json();
    const canonicalManagedRoot = realpathSync.native(managedRoot);

    expect(response.status).toBe(200);
    expect(payload.storageAdmission).toMatchObject({
      accountingStatus: 'observed',
      physicalAvailableBytes: 300,
      activeReservations: 0,
    });
    expect(hostTargets.some((target) => target.startsWith(`${canonicalManagedRoot}/`))).toBe(true);
    expect(hostTargets).not.toContain(realpathSync.native(repoA));
    expect(hostTargets).not.toContain(realpathSync.native(repoB));
  });

  it('marks admission accounting unknown when the configured managed root is unavailable', async () => {
    const unavailableRoot = path.join(fixtureRoot, 'unavailable-managed-root');
    writeFileSync(unavailableRoot, 'not a directory\n');
    process.env.O8_WORKTREE_ROOT = unavailableRoot;

    const response = await GET(new NextRequest('http://127.0.0.1/api/worktrees/retention-usage'));
    const payload = await response.json();

    expect(payload.storageAdmission).toMatchObject({
      accountingStatus: 'unknown',
      physicalAvailableBytes: null,
      requiredReserveBytes: null,
      dispatchHeadroomBytes: null,
    });
  });
});

afterAll(() => {
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
});
