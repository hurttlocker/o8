import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { archiveRootForOwnedSessionRoot } from '@/lib/runtimes/shared/owned-session/archive';
import {
  aggregateDirectoryStorage,
  measureDirectoryStorage,
  type DirectoryStorageTelemetry,
} from './storage-telemetry';
import {
  classifyOwnedSessionArtifact,
  readStorageCategorySnapshot,
  resetStorageCategorySnapshotCache,
} from './storage-categories';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function measurement(
  targetPath: string,
  allocatedBytes: number | null,
  logicalBytes: number | null,
): DirectoryStorageTelemetry {
  return {
    path: targetPath,
    category: 'workspace',
    presence: 'present',
    count: 1,
    allocatedBytes,
    logicalBytes,
    countAccounting: 'observed',
    allocatedBytesAccounting: allocatedBytes === null ? 'unknown' : 'observed',
    logicalBytesAccounting: logicalBytes === null ? 'unknown' : 'observed',
    errors: logicalBytes === null
      ? [{ metric: 'logicalBytes', code: 'EACCES', message: 'logical size unavailable' }]
      : [],
  };
}

describe('storage category telemetry', () => {
  let testRoot = '';

  beforeEach(async () => {
    resetStorageCategorySnapshotCache();
    testRoot = await mkdtemp(path.join(os.tmpdir(), 'o8-storage-categories-'));
  });

  afterEach(async () => {
    resetStorageCategorySnapshotCache();
    if (testRoot) await rm(testRoot, { recursive: true, force: true });
  });

  it('keeps the owned-session classifier explicit', () => {
    expect(classifyOwnedSessionArtifact('session.json')).toBe('runtime');
    expect(classifyOwnedSessionArtifact('runs')).toBe('transcript');
    expect(classifyOwnedSessionArtifact('provider-session.jsonl')).toBe('transcript');
  });

  it('measures additive workspace and owned-session categories from bounded roots', async () => {
    const base = path.join(testRoot, 'worktrees');
    const worktree = path.join(base, 'packet-a');
    await Promise.all([
      mkdir(path.join(worktree, 'node_modules', 'package-a'), { recursive: true }),
      mkdir(path.join(worktree, '.next', 'server'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(worktree, 'source.ts'), 'export const value = 1;\n'),
      writeFile(path.join(worktree, 'node_modules', 'package-a', 'index.js'), 'dependency\n'),
      writeFile(path.join(worktree, '.next', 'server', 'page.js'), 'build output\n'),
    ]);
    const dependencyCacheRoot = path.join(testRoot, 'package-manager-cache');
    await mkdir(path.join(dependencyCacheRoot, 'npm', 'recipe-key', 'cache'), { recursive: true });
    await writeFile(
      path.join(dependencyCacheRoot, 'npm', 'recipe-key', 'cache', 'package.tgz'),
      'persisted native dependency cache\n',
    );

    const ownedRoot = path.join(testRoot, 'owned-runtime');
    const activeSession = path.join(ownedRoot, 'active-session');
    const archivedSession = path.join(
      archiveRootForOwnedSessionRoot(ownedRoot),
      'archived-session',
    );
    await Promise.all([
      mkdir(path.join(activeSession, 'runs'), { recursive: true }),
      mkdir(path.join(archivedSession, 'runs'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(activeSession, 'session.json'), '{"surfaceId":"active"}\n'),
      writeFile(path.join(activeSession, 'runs', 'run.jsonl'), '{"message":"active"}\n'),
      writeFile(path.join(activeSession, 'provider-session.jsonl'), 'provider transcript\n'),
      writeFile(path.join(archivedSession, 'session.json'), '{"surfaceId":"archived"}\n'),
      writeFile(path.join(archivedSession, 'runs', 'run.jsonl'), '{"message":"archived"}\n'),
    ]);

    const snapshot = await readStorageCategorySnapshot(
      [{ repositoryUuid: 'repo-1', bases: [base] }],
      {
        forceRefresh: true,
        ownedRootPaths: [ownedRoot],
        dependencyCacheRootPaths: [dependencyCacheRoot],
      },
    );
    const workspace = aggregateDirectoryStorage(snapshot.repos[0]!.workspaceMeasurements);
    const categories = snapshot.repos[0]!.categories;

    expect(
      snapshot.accountingStatus,
      JSON.stringify(Object.fromEntries(
        Object.entries(snapshot.categories).map(([category, usage]) => [category, usage.errors]),
      )),
    ).toBe('observed');
    expect(snapshot.freshness).toMatchObject({ source: 'measured', ttlMs: 5_000 });
    expect(categories.source.allocatedBytes).not.toBeNull();
    expect(categories.source.measurementMethod).toBe('workspace-residual');
    expect(categories.dependency.allocatedBytes).toBeGreaterThan(0);
    expect(categories.dependency.measurementMethod).toBe('known-path-sum');
    const dependencyCache = await measureDirectoryStorage(dependencyCacheRoot);
    expect(snapshot.dependencyCacheMeasurements).toEqual([
      expect.objectContaining({
        path: dependencyCacheRoot,
        presence: 'present',
        allocatedBytes: dependencyCache.allocatedBytes,
        logicalBytes: dependencyCache.logicalBytes,
      }),
    ]);
    expect(snapshot.categories.dependency.allocatedBytes).toBe(
      (categories.dependency.allocatedBytes ?? 0) + (dependencyCache.allocatedBytes ?? 0),
    );
    expect(snapshot.categories.dependency.logicalBytes).toBe(
      (categories.dependency.logicalBytes ?? 0) + (dependencyCache.logicalBytes ?? 0),
    );
    expect(categories.build.allocatedBytes).toBeGreaterThan(0);
    expect(
      (categories.source.allocatedBytes ?? 0)
        + (categories.dependency.allocatedBytes ?? 0)
        + (categories.build.allocatedBytes ?? 0),
    ).toBe(workspace.allocatedBytes);
    expect(
      (categories.source.logicalBytes ?? 0)
        + (categories.dependency.logicalBytes ?? 0)
        + (categories.build.logicalBytes ?? 0),
    ).toBe(workspace.logicalBytes);
    expect(snapshot.categories.runtime.logicalBytes).toBeGreaterThan(0);
    expect(snapshot.categories.runtime.measurementMethod).toBe('owned-root-residual');
    expect(snapshot.categories.transcript.logicalBytes).toBeGreaterThan(0);
    expect(snapshot.categories.transcript.measurementMethod).toBe(
      'owned-session-artifact-sum',
    );

    const cached = await readStorageCategorySnapshot(
      [{ repositoryUuid: 'repo-1', bases: [base] }],
      { ownedRootPaths: [ownedRoot], dependencyCacheRootPaths: [dependencyCacheRoot] },
    );
    expect(cached.measuredAt).toBe(snapshot.measuredAt);
    expect(cached.freshness.source).toBe('cache');
  });

  it('marks unknown and impossible residuals instead of clamping them to zero', async () => {
    const base = path.join(testRoot, 'worktrees');
    const worktree = path.join(base, 'packet-a');
    const nodeModules = path.join(worktree, 'node_modules');
    const ownedRoot = path.join(testRoot, 'owned-runtime');
    const snapshot = await readStorageCategorySnapshot(
      [{ repositoryUuid: 'repo-1', bases: [base] }],
      {
        forceRefresh: true,
        ownedRootPaths: [ownedRoot],
        dependencyCacheRootPaths: [],
        dependencies: {
          readDirectory: async (targetPath) => {
            if (targetPath === base) return [{ name: 'packet-a', isDirectory: () => true }];
            throw errno('ENOENT');
          },
          readPathStat: async (targetPath) => {
            if (targetPath === nodeModules) {
              return { blocks: BigInt(1), size: BigInt(1), isDirectory: () => true };
            }
            throw errno('ENOENT');
          },
          measureDirectory: async (targetPath) => {
            if (targetPath === base) return measurement(targetPath, 10, 10);
            if (targetPath === nodeModules) return measurement(targetPath, 20, null);
            return {
              ...measurement(targetPath, 0, 0),
              presence: 'absent',
              count: 0,
            };
          },
        },
      },
    );

    expect(snapshot.accountingStatus).toBe('partial');
    expect(snapshot.repos[0]!.categories.source).toMatchObject({
      allocatedBytes: null,
      logicalBytes: null,
      unknownAllocatedByteMeasurements: 1,
      unknownLogicalByteMeasurements: 1,
    });
    expect(snapshot.repos[0]!.categories.source.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'allocatedBytes', code: 'ERANGE' }),
      expect.objectContaining({ metric: 'logicalBytes', code: 'EACCES' }),
    ]));
  });

  it('coalesces concurrent refreshes into one measurement pass', async () => {
    const ownedRoot = path.join(testRoot, 'owned-runtime');
    const repos = Array.from({ length: 8 }, (_, index) => ({
      repositoryUuid: `repo-${index}`,
      bases: [path.join(testRoot, `worktrees-${index}`)],
    }));
    let measureCalls = 0;
    let activeMeasurements = 0;
    let maxActiveMeasurements = 0;
    const options = {
      forceRefresh: true,
      ownedRootPaths: [ownedRoot],
      dependencyCacheRootPaths: [],
      dependencies: {
        readDirectory: async () => { throw errno('ENOENT'); },
        measureDirectory: async (targetPath: string) => {
          measureCalls += 1;
          activeMeasurements += 1;
          maxActiveMeasurements = Math.max(maxActiveMeasurements, activeMeasurements);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeMeasurements -= 1;
          return {
            ...measurement(targetPath, 0, 0),
            presence: 'absent' as const,
            count: 0,
          };
        },
      },
    };

    const [first, second] = await Promise.all([
      readStorageCategorySnapshot(repos, options),
      readStorageCategorySnapshot(repos, options),
    ]);

    expect([first.freshness.source, second.freshness.source].sort()).toEqual([
      'coalesced',
      'measured',
    ]);
    expect(measureCalls).toBe(10);
    expect(maxActiveMeasurements).toBeLessThanOrEqual(6);
  });
});
