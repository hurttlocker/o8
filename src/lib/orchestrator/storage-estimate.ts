import { readdir } from 'node:fs/promises';
import path from 'node:path';

import type { OrchestratorPacketStorageAdmission } from '@/lib/orchestrator/types';
import { resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';
import {
  readCachedDirectoryStorage,
  refreshDirectoryStorage,
  type DirectoryStorageTelemetry,
} from '@/lib/worktree/storage-telemetry';

const GIB = 1024 * 1024 * 1024;
const DEFAULT_ESTIMATE_FLOOR_BYTES = 2 * GIB;
const UNOBSERVED_ESTIMATE_BYTES = 8 * GIB;
const HISTORY_HEADROOM_RATIO = 1.25;
const SOURCE_HEADROOM_RATIO = 2;

export interface RepoStorageEstimate {
  status: 'observed' | 'unknown';
  exactBytes: number | null;
  source: OrchestratorPacketStorageAdmission['estimateSource'];
  historySamples: number;
  workspacePaths: string[];
  error: string | null;
}

export interface RepoStorageEstimateDependencies {
  readCachedMeasurement?: (targetPath: string) => DirectoryStorageTelemetry | null;
  refreshMeasurement?: (targetPath: string) => Promise<DirectoryStorageTelemetry>;
  defer?: (task: () => void) => void;
}

function safeEstimateBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Workspace growth estimate is outside the safe integer range.');
  }
  return value;
}

async function directoryNames(base: string): Promise<string[]> {
  try {
    const entries = await readdir(base, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => path.join(base, entry.name));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function scheduleRefreshes(
  paths: string[],
  refresh: (targetPath: string) => Promise<DirectoryStorageTelemetry>,
  defer: (task: () => void) => void,
) {
  defer(() => {
    void (async () => {
      for (const targetPath of paths) {
        try {
          await refresh(targetPath);
        } catch { /* A later dispatch keeps the last cached value and retries. */ }
      }
    })();
  });
}

export async function observeRepoWorkspacePaths(repoPath: string): Promise<string[]> {
  const normalizedRepo = path.resolve(repoPath);
  const layout = resolveWorktreeRootLayout(normalizedRepo);
  const roots = [...layout.bases, path.join(normalizedRepo, '.claude', 'worktrees')];
  const nested = await Promise.all([...new Set(roots)].map(directoryNames));
  return [...new Set(nested.flat().map((candidate) => path.resolve(candidate)))].sort();
}

export async function observeRepoStorageEstimate(
  repoPath: string,
  dependencies: RepoStorageEstimateDependencies = {},
): Promise<RepoStorageEstimate> {
  const normalizedRepo = path.resolve(repoPath);
  const readCached = dependencies.readCachedMeasurement ?? readCachedDirectoryStorage;
  const refresh = dependencies.refreshMeasurement ?? refreshDirectoryStorage;
  const defer = dependencies.defer ?? setImmediate;
  try {
    const layout = resolveWorktreeRootLayout(normalizedRepo);
    const bases = [...new Set(layout.bases.map((base) => path.resolve(base)))];
    const nested = await Promise.all(bases.map(directoryNames));
    const workspacePaths = [...new Set(nested.flat().map((candidate) => path.resolve(candidate)))].sort();
    if (workspacePaths.length > 0) {
      const measurements = workspacePaths
        .map((candidate) => readCached(candidate))
        .filter((measurement): measurement is DirectoryStorageTelemetry => (
          measurement?.allocatedBytesAccounting === 'observed'
          && measurement.allocatedBytes !== null
        ));
      scheduleRefreshes(workspacePaths, refresh, defer);
      const largest = measurements.length > 0
        ? Math.max(...measurements.map((measurement) => measurement.allocatedBytes!))
        : 0;
      const exactBytes = largest > 0
        ? Math.max(DEFAULT_ESTIMATE_FLOOR_BYTES, Math.ceil(largest * HISTORY_HEADROOM_RATIO))
        : UNOBSERVED_ESTIMATE_BYTES;
      return {
        status: 'observed',
        exactBytes: safeEstimateBytes(exactBytes),
        source: 'same-repo-history',
        historySamples: measurements.length,
        workspacePaths,
        error: measurements.length === workspacePaths.length
          ? null
          : `Using a conservative estimate while ${workspacePaths.length - measurements.length} worktree measurement(s) refresh.`,
      };
    }

    const source = readCached(normalizedRepo);
    scheduleRefreshes([normalizedRepo], refresh, defer);
    const sourceBytes = source?.allocatedBytesAccounting === 'observed'
      ? source.allocatedBytes
      : null;
    return {
      status: 'observed',
      exactBytes: safeEstimateBytes(sourceBytes !== null
        ? Math.max(DEFAULT_ESTIMATE_FLOOR_BYTES, Math.ceil(sourceBytes * SOURCE_HEADROOM_RATIO))
        : UNOBSERVED_ESTIMATE_BYTES),
      source: 'source-size-fallback',
      historySamples: 0,
      workspacePaths,
      error: sourceBytes === null ? 'Using a conservative estimate while the source measurement refreshes.' : null,
    };
  } catch (error) {
    return {
      status: 'observed',
      exactBytes: UNOBSERVED_ESTIMATE_BYTES,
      source: 'source-size-fallback',
      historySamples: 0,
      workspacePaths: [],
      error: `Using a conservative estimate because workspace history could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
