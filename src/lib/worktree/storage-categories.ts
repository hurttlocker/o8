import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { archiveRootForOwnedSessionRoot } from '@/lib/runtimes/shared/owned-session/archive';
import { ownedRoots } from '@/lib/runtimes/shared/owned-session-index';
import {
  aggregateDirectoryStorage,
  measureDirectoryStorage,
  type DirectoryStorageTelemetry,
  type StorageAccountingStatus,
  type StorageByteCategory,
  type StorageMeasurementError,
} from '@/lib/worktree/storage-telemetry';

export const DEPENDENCY_STORAGE_PATHS = [
  'node_modules',
  '.venv',
  'venv',
  'vendor',
  'Pods',
] as const;

export const BUILD_STORAGE_PATHS = [
  '.next',
  '.turbo',
  'target',
  'src-tauri/target',
  'DerivedData',
  'dist',
  'build',
  'coverage',
] as const;

const CATEGORY_SNAPSHOT_TTL_MS = 5_000;
const MEASUREMENT_CONCURRENCY = 6;
const OWNED_SESSION_METADATA_FILE = 'session.json';

interface DirectoryEntryLike {
  isDirectory(): boolean;
  name: string;
}

interface PathStatLike {
  blocks: bigint;
  isDirectory(): boolean;
  size: bigint;
}

export interface StorageCategoryRepoInput {
  repositoryUuid: string;
  bases: string[];
}

export interface StorageCategoryUsage {
  category: Exclude<StorageByteCategory, 'workspace'>;
  measurementMethod:
    | 'workspace-residual'
    | 'known-path-sum'
    | 'owned-root-residual'
    | 'owned-session-artifact-sum';
  accountingStatus: StorageAccountingStatus;
  allocatedBytes: number | null;
  logicalBytes: number | null;
  observedAllocatedBytes: number | null;
  observedLogicalBytes: number | null;
  unknownAllocatedByteMeasurements: number;
  unknownLogicalByteMeasurements: number;
  errors: StorageMeasurementError[];
}

export interface RepoStorageCategoryProjection {
  repositoryUuid: string;
  workspaceMeasurements: DirectoryStorageTelemetry[];
  categories: Pick<Record<Exclude<StorageByteCategory, 'workspace'>, StorageCategoryUsage>,
    'source' | 'dependency' | 'build'>;
}

export interface StorageCategorySnapshot {
  schema: 'o8/storage-category-telemetry/v1';
  measuredAt: string;
  accountingStatus: StorageAccountingStatus;
  freshness: {
    source: 'measured' | 'cache' | 'coalesced';
    ageMs: number;
    ttlMs: number;
  };
  categories: Record<Exclude<StorageByteCategory, 'workspace'>, StorageCategoryUsage>;
  repos: RepoStorageCategoryProjection[];
}

interface StorageCategoryDependencies {
  readDirectory: (targetPath: string) => Promise<DirectoryEntryLike[]>;
  readPathStat: (targetPath: string) => Promise<PathStatLike>;
  measureDirectory: (targetPath: string) => Promise<DirectoryStorageTelemetry>;
  now: () => number;
}

export interface ReadStorageCategoryOptions {
  forceRefresh?: boolean;
  ownedRootPaths?: string[];
  ttlMs?: number;
  dependencies?: Partial<StorageCategoryDependencies>;
}

interface SnapshotCacheEntry {
  key: string;
  measuredAtMs: number;
  snapshot: Omit<StorageCategorySnapshot, 'freshness'>;
}

let snapshotCache: SnapshotCacheEntry | null = null;
let snapshotInflight: { key: string; promise: Promise<SnapshotCacheEntry> } | null = null;

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function storageError(
  metric: StorageMeasurementError['metric'],
  targetPath: string,
  error: unknown,
): StorageMeasurementError {
  return {
    metric,
    code: errorCode(error),
    message: `${targetPath}: ${errorMessage(error)}`,
  };
}

function unknownMeasurement(
  targetPath: string,
  category: StorageByteCategory,
  error: unknown,
): DirectoryStorageTelemetry {
  return {
    path: path.resolve(targetPath),
    category,
    presence: 'unknown',
    count: null,
    allocatedBytes: null,
    logicalBytes: null,
    countAccounting: 'unknown',
    allocatedBytesAccounting: 'unknown',
    logicalBytesAccounting: 'unknown',
    errors: [
      storageError('count', targetPath, error),
      storageError('allocatedBytes', targetPath, error),
      storageError('logicalBytes', targetPath, error),
    ],
  };
}

function safeBigIntBytes(value: bigint, label: string): number {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} is outside the safe integer range.`);
  }
  return Number(value);
}

function byteAccountingStatus(
  allocatedBytes: number | null,
  logicalBytes: number | null,
): StorageAccountingStatus {
  if (allocatedBytes !== null && logicalBytes !== null) return 'observed';
  if (allocatedBytes === null && logicalBytes === null) return 'unknown';
  return 'partial';
}

function usageFromMeasurements(
  category: StorageCategoryUsage['category'],
  measurementMethod: StorageCategoryUsage['measurementMethod'],
  measurements: DirectoryStorageTelemetry[],
): StorageCategoryUsage {
  const aggregate = aggregateDirectoryStorage(measurements);
  return {
    category,
    measurementMethod,
    accountingStatus: byteAccountingStatus(aggregate.allocatedBytes, aggregate.logicalBytes),
    allocatedBytes: aggregate.allocatedBytes,
    logicalBytes: aggregate.logicalBytes,
    observedAllocatedBytes: aggregate.observedAllocatedBytes,
    observedLogicalBytes: aggregate.observedLogicalBytes,
    unknownAllocatedByteMeasurements: aggregate.unknownAllocatedByteMeasurements,
    unknownLogicalByteMeasurements: aggregate.unknownLogicalByteMeasurements,
    errors: aggregate.errors,
  };
}

function sumCategoryUsages(
  category: StorageCategoryUsage['category'],
  usages: StorageCategoryUsage[],
): StorageCategoryUsage {
  const allocatedObserved = usages.every((usage) => usage.allocatedBytes !== null);
  const logicalObserved = usages.every((usage) => usage.logicalBytes !== null);
  const allocatedBytes = allocatedObserved
    ? usages.reduce((sum, usage) => sum + (usage.allocatedBytes ?? 0), 0)
    : null;
  const logicalBytes = logicalObserved
    ? usages.reduce((sum, usage) => sum + (usage.logicalBytes ?? 0), 0)
    : null;
  return {
    category,
    measurementMethod: usages[0]?.measurementMethod ?? (
      category === 'source' ? 'workspace-residual'
        : category === 'runtime' ? 'owned-root-residual'
          : category === 'transcript' ? 'owned-session-artifact-sum'
            : 'known-path-sum'
    ),
    accountingStatus: byteAccountingStatus(allocatedBytes, logicalBytes),
    allocatedBytes,
    logicalBytes,
    observedAllocatedBytes: allocatedObserved ? allocatedBytes : null,
    observedLogicalBytes: logicalObserved ? logicalBytes : null,
    unknownAllocatedByteMeasurements: usages.reduce(
      (sum, usage) => sum + usage.unknownAllocatedByteMeasurements,
      0,
    ),
    unknownLogicalByteMeasurements: usages.reduce(
      (sum, usage) => sum + usage.unknownLogicalByteMeasurements,
      0,
    ),
    errors: usages.flatMap((usage) => usage.errors),
  };
}

function residualMetric(
  metric: 'allocatedBytes' | 'logicalBytes',
  label: string,
  total: number | null,
  deductions: Array<number | null>,
): { value: number | null; error: StorageMeasurementError | null } {
  if (total === null || deductions.some((value) => value === null)) {
    return { value: null, error: null };
  }
  const value = total - deductions.reduce<number>((sum, item) => sum + (item ?? 0), 0);
  if (value < 0) {
    return {
      value: null,
      error: {
        metric,
        code: 'ERANGE',
        message: `${label}: measured child storage exceeds its parent storage.`,
      },
    };
  }
  return { value, error: null };
}

function residualUsage(
  category: 'source' | 'runtime',
  label: string,
  total: { allocatedBytes: number | null; logicalBytes: number | null; errors: StorageMeasurementError[] },
  deductions: StorageCategoryUsage[],
): StorageCategoryUsage {
  const allocated = residualMetric(
    'allocatedBytes',
    label,
    total.allocatedBytes,
    deductions.map((usage) => usage.allocatedBytes),
  );
  const logical = residualMetric(
    'logicalBytes',
    label,
    total.logicalBytes,
    deductions.map((usage) => usage.logicalBytes),
  );
  const errors = [
    ...total.errors,
    ...deductions.flatMap((usage) => usage.errors),
    ...(allocated.error ? [allocated.error] : []),
    ...(logical.error ? [logical.error] : []),
  ];
  return {
    category,
    measurementMethod: category === 'source' ? 'workspace-residual' : 'owned-root-residual',
    accountingStatus: byteAccountingStatus(allocated.value, logical.value),
    allocatedBytes: allocated.value,
    logicalBytes: logical.value,
    observedAllocatedBytes: allocated.value,
    observedLogicalBytes: logical.value,
    unknownAllocatedByteMeasurements: allocated.value === null ? 1 : 0,
    unknownLogicalByteMeasurements: logical.value === null ? 1 : 0,
    errors,
  };
}

async function mapWithConcurrency<T, TResult>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  const workers = Math.min(Math.max(1, limit), Math.max(1, items.length));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]!);
    }
  }));
  return results;
}

function createAsyncLimiter(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

function defaultDependencies(): StorageCategoryDependencies {
  return {
    readDirectory: async (targetPath) => readdir(targetPath, { withFileTypes: true }),
    readPathStat: async (targetPath) => lstat(targetPath, { bigint: true }),
    measureDirectory: measureDirectoryStorage,
    now: Date.now,
  };
}

async function listChildDirectories(
  root: string,
  dependencies: StorageCategoryDependencies,
): Promise<{ paths: string[]; error: unknown | null }> {
  try {
    const entries = await dependencies.readDirectory(root);
    return {
      paths: entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => path.join(root, entry.name)),
      error: null,
    };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { paths: [], error: null };
    return { paths: [], error };
  }
}

async function measurePath(
  targetPath: string,
  category: StorageByteCategory,
  dependencies: StorageCategoryDependencies,
): Promise<DirectoryStorageTelemetry> {
  try {
    const info = await dependencies.readPathStat(targetPath);
    if (info.isDirectory()) {
      const measured = await dependencies.measureDirectory(targetPath);
      return { ...measured, category };
    }
    const allocatedBytes = safeBigIntBytes(info.blocks * BigInt(512), 'Allocated file size');
    const logicalBytes = safeBigIntBytes(info.size, 'Logical file size');
    return {
      path: path.resolve(targetPath),
      category,
      presence: 'present',
      count: 1,
      allocatedBytes,
      logicalBytes,
      countAccounting: 'observed',
      allocatedBytesAccounting: 'observed',
      logicalBytesAccounting: 'observed',
      errors: [],
    };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return {
        path: path.resolve(targetPath),
        category,
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
    return unknownMeasurement(targetPath, category, error);
  }
}

export function classifyOwnedSessionArtifact(name: string): 'runtime' | 'transcript' {
  return name === OWNED_SESSION_METADATA_FILE ? 'runtime' : 'transcript';
}

async function measureRepoCategories(
  input: StorageCategoryRepoInput,
  dependencies: StorageCategoryDependencies,
): Promise<RepoStorageCategoryProjection> {
  const bases = [...new Set(input.bases.map((base) => path.resolve(base)))];
  const workspaceMeasurements = await mapWithConcurrency(
    bases,
    MEASUREMENT_CONCURRENCY,
    (base) => dependencies.measureDirectory(base),
  );
  const discoveries = await Promise.all(
    bases.map((base) => listChildDirectories(base, dependencies)),
  );
  const worktrees = discoveries.flatMap((result) => result.paths);
  const dependencyTargets = worktrees.flatMap((worktree) => (
    DEPENDENCY_STORAGE_PATHS.map((relativePath) => path.join(worktree, relativePath))
  ));
  const buildTargets = worktrees.flatMap((worktree) => (
    BUILD_STORAGE_PATHS.map((relativePath) => path.join(worktree, relativePath))
  ));
  const [dependencyMeasurements, buildMeasurements] = await Promise.all([
    mapWithConcurrency(dependencyTargets, MEASUREMENT_CONCURRENCY, (targetPath) => (
      measurePath(targetPath, 'dependency', dependencies)
    )),
    mapWithConcurrency(buildTargets, MEASUREMENT_CONCURRENCY, (targetPath) => (
      measurePath(targetPath, 'build', dependencies)
    )),
  ]);
  for (let index = 0; index < discoveries.length; index += 1) {
    const discovery = discoveries[index]!;
    if (!discovery.error) continue;
    const base = bases[index]!;
    dependencyMeasurements.push(unknownMeasurement(base, 'dependency', discovery.error));
    buildMeasurements.push(unknownMeasurement(base, 'build', discovery.error));
  }
  const dependency = usageFromMeasurements(
    'dependency',
    'known-path-sum',
    dependencyMeasurements,
  );
  const build = usageFromMeasurements('build', 'known-path-sum', buildMeasurements);
  const workspace = aggregateDirectoryStorage(workspaceMeasurements);
  const source = residualUsage('source', input.repositoryUuid, workspace, [dependency, build]);
  return {
    repositoryUuid: input.repositoryUuid,
    workspaceMeasurements,
    categories: { source, dependency, build },
  };
}

async function measureOwnedCategories(
  roots: string[],
  dependencies: StorageCategoryDependencies,
): Promise<{ runtime: StorageCategoryUsage; transcript: StorageCategoryUsage }> {
  const totalMeasurements = await mapWithConcurrency(
    roots,
    MEASUREMENT_CONCURRENCY,
    (root) => dependencies.measureDirectory(root),
  );
  const sessionDiscoveries = await Promise.all(
    roots.map((root) => listChildDirectories(root, dependencies)),
  );
  const sessionDirs = sessionDiscoveries.flatMap((result) => result.paths);
  const artifactDiscoveries = await Promise.all(sessionDirs.map(async (sessionDir) => {
    try {
      const entries = await dependencies.readDirectory(sessionDir);
      return {
        sessionDir,
        paths: entries
          .filter((entry) => classifyOwnedSessionArtifact(entry.name) === 'transcript')
          .map((entry) => path.join(sessionDir, entry.name)),
        error: null as unknown | null,
      };
    } catch (error) {
      return { sessionDir, paths: [] as string[], error };
    }
  }));
  const transcriptMeasurements = await mapWithConcurrency(
    artifactDiscoveries.flatMap((result) => result.paths),
    MEASUREMENT_CONCURRENCY,
    (targetPath) => measurePath(targetPath, 'transcript', dependencies),
  );
  for (let index = 0; index < sessionDiscoveries.length; index += 1) {
    const discovery = sessionDiscoveries[index]!;
    if (!discovery.error) continue;
    transcriptMeasurements.push(unknownMeasurement(roots[index]!, 'transcript', discovery.error));
  }
  for (const discovery of artifactDiscoveries) {
    if (!discovery.error) continue;
    transcriptMeasurements.push(
      unknownMeasurement(discovery.sessionDir, 'transcript', discovery.error),
    );
  }
  const transcript = usageFromMeasurements(
    'transcript',
    'owned-session-artifact-sum',
    transcriptMeasurements,
  );
  const total = aggregateDirectoryStorage(totalMeasurements);
  return {
    runtime: residualUsage('runtime', 'owned runtime storage', total, [transcript]),
    transcript,
  };
}

function resolvedOwnedRoots(overrides?: string[]): string[] {
  const activeRoots = overrides ?? ownedRoots().map((entry) => entry.root);
  const allRoots = activeRoots.flatMap((root) => [
    path.resolve(root),
    path.resolve(archiveRootForOwnedSessionRoot(root)),
  ]);
  return [...new Set(allRoots)];
}

function snapshotKey(repos: StorageCategoryRepoInput[], roots: string[]): string {
  return JSON.stringify({
    repos: repos.map((repo) => ({
      repositoryUuid: repo.repositoryUuid,
      bases: [...new Set(repo.bases.map((base) => path.resolve(base)))].sort(),
    })).sort((left, right) => left.repositoryUuid.localeCompare(right.repositoryUuid)),
    roots: [...roots].sort(),
  });
}

async function buildSnapshot(
  key: string,
  repos: StorageCategoryRepoInput[],
  roots: string[],
  dependencies: StorageCategoryDependencies,
): Promise<SnapshotCacheEntry> {
  const limitMeasurement = createAsyncLimiter(MEASUREMENT_CONCURRENCY);
  const boundedDependencies: StorageCategoryDependencies = {
    ...dependencies,
    measureDirectory: (targetPath) => limitMeasurement(
      () => dependencies.measureDirectory(targetPath),
    ),
  };
  const [repoProjections, owned] = await Promise.all([
    Promise.all(repos.map((repo) => measureRepoCategories(repo, boundedDependencies))),
    measureOwnedCategories(roots, boundedDependencies),
  ]);
  const source = sumCategoryUsages(
    'source',
    repoProjections.map((repo) => repo.categories.source),
  );
  const dependency = sumCategoryUsages(
    'dependency',
    repoProjections.map((repo) => repo.categories.dependency),
  );
  const build = sumCategoryUsages(
    'build',
    repoProjections.map((repo) => repo.categories.build),
  );
  const categories = {
    source,
    dependency,
    build,
    runtime: owned.runtime,
    transcript: owned.transcript,
  };
  const statuses = Object.values(categories).map((usage) => usage.accountingStatus);
  const accountingStatus: StorageAccountingStatus = statuses.every((status) => status === 'observed')
    ? 'observed'
    : statuses.every((status) => status === 'unknown')
      ? 'unknown'
      : 'partial';
  const measuredAtMs = dependencies.now();
  return {
    key,
    measuredAtMs,
    snapshot: {
      schema: 'o8/storage-category-telemetry/v1',
      measuredAt: new Date(measuredAtMs).toISOString(),
      accountingStatus,
      categories,
      repos: repoProjections,
    },
  };
}

function withFreshness(
  entry: SnapshotCacheEntry,
  nowMs: number,
  source: StorageCategorySnapshot['freshness']['source'],
  ttlMs: number,
): StorageCategorySnapshot {
  return {
    ...entry.snapshot,
    freshness: {
      source,
      ageMs: Math.max(0, nowMs - entry.measuredAtMs),
      ttlMs,
    },
  };
}

export async function readStorageCategorySnapshot(
  repos: StorageCategoryRepoInput[],
  options: ReadStorageCategoryOptions = {},
): Promise<StorageCategorySnapshot> {
  const defaults = defaultDependencies();
  const dependencies = { ...defaults, ...options.dependencies };
  const roots = resolvedOwnedRoots(options.ownedRootPaths);
  const key = snapshotKey(repos, roots);
  const ttlMs = options.ttlMs ?? CATEGORY_SNAPSHOT_TTL_MS;
  const nowMs = dependencies.now();
  if (!options.forceRefresh
    && snapshotCache?.key === key
    && nowMs - snapshotCache.measuredAtMs < ttlMs) {
    return withFreshness(snapshotCache, nowMs, 'cache', ttlMs);
  }
  if (snapshotInflight?.key === key) {
    const entry = await snapshotInflight.promise;
    return withFreshness(entry, dependencies.now(), 'coalesced', ttlMs);
  }
  const promise = buildSnapshot(key, repos, roots, dependencies);
  snapshotInflight = { key, promise };
  try {
    const entry = await promise;
    snapshotCache = entry;
    return withFreshness(entry, dependencies.now(), 'measured', ttlMs);
  } finally {
    if (snapshotInflight?.promise === promise) snapshotInflight = null;
  }
}

export function resetStorageCategorySnapshotCache(): void {
  snapshotCache = null;
  snapshotInflight = null;
}
