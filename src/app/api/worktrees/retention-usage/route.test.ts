import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requirePanelAuthMock,
  listReposMock,
  measureHostVolumeMock,
  readAdmissionMock,
  readCategoryMock,
  projectPressureMock,
  countSnapshotsMock,
} = vi.hoisted(() => ({
  requirePanelAuthMock: vi.fn(),
  listReposMock: vi.fn(),
  measureHostVolumeMock: vi.fn(),
  readAdmissionMock: vi.fn(),
  readCategoryMock: vi.fn(),
  projectPressureMock: vi.fn(),
  countSnapshotsMock: vi.fn(),
}));

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: requirePanelAuthMock }));
vi.mock('@/lib/repos/registry', () => ({ listRepos: listReposMock }));
vi.mock('@/lib/orchestrator/storage-admission', () => ({
  readPacketStorageAdmissionProjection: readAdmissionMock,
}));
vi.mock('@/lib/orchestrator/storage-pressure-policy', () => ({
  projectStoragePressurePolicy: projectPressureMock,
}));
vi.mock('@/lib/worktree/snapshot-state', () => ({
  countWorkspaceSnapshotsByState: countSnapshotsMock,
}));
vi.mock('@/lib/worktree/storage-categories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/worktree/storage-categories')>();
  return { ...actual, readStorageCategorySnapshot: readCategoryMock };
});
vi.mock('@/lib/worktree/root-layout', () => ({
  resolveManagedWorktreeStorageTarget: () => '/worktrees/primary',
  resolveWorktreeRootLayout: () => ({
    configuredRoot: '/worktrees',
    primaryBase: '/worktrees/primary',
    legacyBase: '/repo/.cortex-worktrees',
    bases: ['/worktrees/primary', '/repo/.cortex-worktrees'],
    repoKey: 'repo-key',
  }),
}));
vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>();
  return {
    ...actual,
    measureHostVolume: measureHostVolumeMock,
  };
});

import { GET } from './route';

describe('GET /api/worktrees/retention-usage', () => {
  beforeEach(() => {
    requirePanelAuthMock.mockReset().mockReturnValue(null);
    listReposMock.mockReset().mockResolvedValue([{
      id: 'repo-1',
      name: 'o8',
      localPath: '/repo',
    }]);
    measureHostVolumeMock.mockReset().mockResolvedValue({
      accountingStatus: 'observed',
      targetPath: '/worktrees',
      probePath: '/',
      volumeId: 'device:primary',
      freeBytes: 400,
      availableBytes: 300,
      totalBytes: 1_000,
      error: null,
    });
    readAdmissionMock.mockReset().mockResolvedValue({
      accountingStatus: 'observed',
      reserveRatio: 0.1,
      absoluteFloorBytes: 10_000,
      physicalAvailableBytes: 300,
      reservedBytes: 100,
      requiredReserveBytes: 100,
      dispatchHeadroomBytes: 100,
      activeReservations: 1,
    });
    projectPressureMock.mockReset().mockReturnValue({
      mode: 'pressure',
      automaticParkingEnabled: true,
      eligibleRepositories: 1,
      optedOutRepositories: 0,
    });
    countSnapshotsMock.mockReset().mockReturnValue(2);
    const source = {
      category: 'source',
      measurementMethod: 'workspace-residual',
      accountingStatus: 'partial',
      allocatedBytes: 8_192,
      logicalBytes: null,
      observedAllocatedBytes: 8_192,
      observedLogicalBytes: null,
      unknownAllocatedByteMeasurements: 0,
      unknownLogicalByteMeasurements: 1,
      errors: [{ metric: 'logicalBytes', code: 'EACCES', message: 'permission denied' }],
    };
    const zeroCategory = (category: 'dependency' | 'build' | 'runtime' | 'transcript') => ({
      category,
      measurementMethod: category === 'runtime'
        ? 'owned-root-residual'
        : category === 'transcript'
          ? 'owned-session-artifact-sum'
          : 'known-path-sum',
      accountingStatus: 'observed',
      allocatedBytes: 0,
      logicalBytes: 0,
      observedAllocatedBytes: 0,
      observedLogicalBytes: 0,
      unknownAllocatedByteMeasurements: 0,
      unknownLogicalByteMeasurements: 0,
      errors: [],
    });
    readCategoryMock.mockReset().mockResolvedValue({
      schema: 'o8/storage-category-telemetry/v1',
      measuredAt: '2026-08-15T12:00:00.000Z',
      accountingStatus: 'partial',
      freshness: { source: 'measured', ageMs: 0, ttlMs: 5_000 },
      categories: {
        source,
        dependency: zeroCategory('dependency'),
        build: zeroCategory('build'),
        runtime: zeroCategory('runtime'),
        transcript: zeroCategory('transcript'),
      },
      repos: [{
        repositoryUuid: 'repo-1',
        workspaceMeasurements: [{
          path: '/worktrees/primary',
          category: 'workspace',
          presence: 'present',
          count: 1,
          allocatedBytes: 8_192,
          logicalBytes: null,
          countAccounting: 'observed',
          allocatedBytesAccounting: 'observed',
          logicalBytesAccounting: 'unknown',
          errors: [{ metric: 'logicalBytes', code: 'EACCES', message: 'permission denied' }],
        }, {
          path: '/repo/.cortex-worktrees',
          category: 'workspace',
          presence: 'absent',
          count: 0,
          allocatedBytes: 0,
          logicalBytes: 0,
          countAccounting: 'observed',
          allocatedBytesAccounting: 'observed',
          logicalBytesAccounting: 'observed',
          errors: [],
        }],
        categories: {
          source,
          dependency: zeroCategory('dependency'),
          build: zeroCategory('build'),
        },
      }],
    });
  });

  it('returns structured 503 telemetry instead of zero for unknown accounting', async () => {
    const response = await GET(new NextRequest(
      'http://127.0.0.1/api/worktrees/retention-usage',
    ));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(payload).toMatchObject({
      schema: 'o8/worktree-storage-telemetry/v1',
      accountingStatus: 'partial',
      totalCount: 1,
      totalBytes: 8_192,
      totalAllocatedBytes: 8_192,
      totalLogicalBytes: null,
      observedAllocatedBytes: 8_192,
      observedLogicalBytes: 0,
      unknownAllocatedByteMeasurements: 0,
      unknownLogicalByteMeasurements: 1,
      hostFreeBytes: 400,
      hostTotalBytes: 1_000,
      hostVolumes: [expect.objectContaining({ volumeId: 'device:primary' })],
      storageAdmission: expect.objectContaining({
        reservedBytes: 100,
        dispatchHeadroomBytes: 100,
      }),
      storagePressure: {
        mode: 'pressure',
        automaticParkingEnabled: true,
        eligibleRepositories: 1,
        optedOutRepositories: 0,
        parkedWorkspaces: 2,
        repositories: [{ id: 'repo-1', name: 'o8', parkingDisabled: false }],
      },
      categoryStorage: expect.objectContaining({
        measuredAt: '2026-08-15T12:00:00.000Z',
        accountingStatus: 'partial',
        freshness: { source: 'measured', ageMs: 0, ttlMs: 5_000 },
        categories: expect.objectContaining({
          source: expect.objectContaining({ logicalBytes: null }),
        }),
      }),
      repos: [{
        id: 'repo-1',
        count: 1,
        bytes: 8_192,
        allocatedBytes: 8_192,
        logicalBytes: null,
        accountingStatus: 'partial',
      }],
    });
    expect(readAdmissionMock).toHaveBeenCalledWith(['/worktrees/primary']);
  });

  it('reports every distinct volume that contains a configured or legacy worktree root', async () => {
    measureHostVolumeMock.mockImplementation(async (targetPath: string) => ({
      accountingStatus: 'observed',
      targetPath,
      probePath: targetPath,
      volumeId: targetPath === '/repo/.cortex-worktrees' ? 'device:external' : 'device:primary',
      freeBytes: targetPath === '/repo/.cortex-worktrees' ? 800 : 400,
      availableBytes: targetPath === '/repo/.cortex-worktrees' ? 700 : 300,
      totalBytes: targetPath === '/repo/.cortex-worktrees' ? 2_000 : 1_000,
      error: null,
    }));

    const response = await GET(new NextRequest(
      'http://127.0.0.1/api/worktrees/retention-usage',
    ));
    const payload = await response.json();

    expect(payload.hostVolumes).toEqual(expect.arrayContaining([
      expect.objectContaining({ volumeId: 'device:primary' }),
      expect.objectContaining({ volumeId: 'device:external' }),
    ]));
    expect(payload.hostVolumes).toHaveLength(2);
  });

  it('honors the route authentication boundary before measuring storage', async () => {
    const denied = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    requirePanelAuthMock.mockReturnValue(denied);

    const response = await GET(new NextRequest(
      'http://remote.example/api/worktrees/retention-usage',
    ));

    expect(response).toBe(denied);
    expect(listReposMock).not.toHaveBeenCalled();
    expect(measureHostVolumeMock).not.toHaveBeenCalled();
    expect(readCategoryMock).not.toHaveBeenCalled();
  });
});
