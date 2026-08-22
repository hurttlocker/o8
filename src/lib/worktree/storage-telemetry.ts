import { execFile } from 'node:child_process';
import { readdir, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DU_TIMEOUT_MS = 30_000;

export type StorageAccountingStatus = 'observed' | 'partial' | 'unknown';
export type MeasurementAccounting = 'observed' | 'unknown';
export type StorageByteCategory =
  | 'workspace'
  | 'source'
  | 'dependency'
  | 'build'
  | 'runtime'
  | 'transcript';

export interface StorageMeasurementError {
  metric: 'count' | 'allocatedBytes' | 'logicalBytes' | 'hostVolume';
  code: string | null;
  message: string;
}

export interface DirectoryStorageTelemetry {
  path: string;
  category: StorageByteCategory;
  presence: 'present' | 'absent' | 'unknown';
  count: number | null;
  allocatedBytes: number | null;
  logicalBytes: number | null;
  countAccounting: MeasurementAccounting;
  allocatedBytesAccounting: MeasurementAccounting;
  logicalBytesAccounting: MeasurementAccounting;
  errors: StorageMeasurementError[];
}

export interface AggregatedStorageTelemetry {
  accountingStatus: StorageAccountingStatus;
  count: number | null;
  allocatedBytes: number | null;
  logicalBytes: number | null;
  observedCount: number;
  observedAllocatedBytes: number;
  observedLogicalBytes: number;
  unknownCountMeasurements: number;
  unknownAllocatedByteMeasurements: number;
  unknownLogicalByteMeasurements: number;
  errors: StorageMeasurementError[];
}

export interface HostVolumeTelemetry {
  accountingStatus: MeasurementAccounting;
  targetPath: string;
  probePath: string | null;
  volumeId: string | null;
  freeBytes: number | null;
  availableBytes: number | null;
  totalBytes: number | null;
  error: StorageMeasurementError | null;
}

interface DirectoryEntryLike {
  isDirectory(): boolean;
  name: string;
}

interface PathStatLike {
  isDirectory(): boolean;
}

interface StatFsLike {
  bsize: bigint;
  blocks: bigint;
  bfree: bigint;
  bavail: bigint;
}

export interface DirectoryTelemetryDependencies {
  statPath?: (targetPath: string) => Promise<PathStatLike>;
  readDirectory?: (targetPath: string) => Promise<DirectoryEntryLike[]>;
  runAllocatedSize?: (targetPath: string) => Promise<string>;
  runLogicalSize?: (targetPath: string) => Promise<string>;
}

export interface VolumeTelemetryDependencies {
  readStatFs?: (targetPath: string) => Promise<StatFsLike>;
  readVolumeId?: (targetPath: string) => Promise<string>;
}

interface CachedDirectoryStorage {
  measurement: DirectoryStorageTelemetry;
  observedAt: number;
}

const directoryStorageCache = new Map<string, CachedDirectoryStorage>();
const directoryStorageRefreshes = new Map<string, Promise<DirectoryStorageTelemetry>>();

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function measurementError(
  metric: StorageMeasurementError['metric'],
  error: unknown,
): StorageMeasurementError {
  return { metric, code: errorCode(error), message: errorMessage(error) };
}

async function runDuSize(targetPath: string, apparent: boolean): Promise<string> {
  const args = apparent
    ? process.platform === 'darwin'
      ? ['-skA', targetPath]
      : ['-sk', '--apparent-size', targetPath]
    : ['-sk', targetPath];
  const { stdout } = await execFileAsync('du', args, {
    env: { ...process.env, LC_ALL: 'C' },
    windowsHide: true,
    timeout: DU_TIMEOUT_MS,
  });
  return stdout;
}

function parseDuBytes(stdout: string, metric: 'allocated' | 'logical'): number {
  const match = /^\s*(\d+)/.exec(stdout);
  if (!match) throw new Error(`du returned no ${metric} size.`);
  const kibibytes = Number(match[1]);
  const bytes = kibibytes * 1024;
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`du returned an ${metric} size outside the safe integer range.`);
  }
  return bytes;
}

export async function measureDirectoryStorage(
  targetPath: string,
  dependencies: DirectoryTelemetryDependencies = {},
): Promise<DirectoryStorageTelemetry> {
  const resolvedPath = path.resolve(targetPath);
  const statPath = dependencies.statPath ?? stat;
  const readDirectory = dependencies.readDirectory ?? (async (dir: string) => (
    readdir(dir, { withFileTypes: true })
  ));

  try {
    const entry = await statPath(resolvedPath);
    if (!entry.isDirectory()) {
      const error = measurementError('count', new Error('Worktree base is not a directory.'));
      return {
        path: resolvedPath,
        category: 'workspace',
        presence: 'unknown',
        count: null,
        allocatedBytes: null,
        logicalBytes: null,
        countAccounting: 'unknown',
        allocatedBytesAccounting: 'unknown',
        logicalBytesAccounting: 'unknown',
        errors: [
          error,
          { ...error, metric: 'allocatedBytes' },
          { ...error, metric: 'logicalBytes' },
        ],
      };
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return {
        path: resolvedPath,
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
    return {
      path: resolvedPath,
      category: 'workspace',
      presence: 'unknown',
      count: null,
      allocatedBytes: null,
      logicalBytes: null,
      countAccounting: 'unknown',
      allocatedBytesAccounting: 'unknown',
      logicalBytesAccounting: 'unknown',
      errors: [
        measurementError('count', error),
        measurementError('allocatedBytes', error),
        measurementError('logicalBytes', error),
      ],
    };
  }

  const allocatedSize = dependencies.runAllocatedSize
    ?? ((dir: string) => runDuSize(dir, false));
  const logicalSize = dependencies.runLogicalSize
    ?? ((dir: string) => runDuSize(dir, true));
  const [entriesResult, allocatedSizeResult, logicalSizeResult] = await Promise.allSettled([
    readDirectory(resolvedPath),
    allocatedSize(resolvedPath),
    logicalSize(resolvedPath),
  ]);
  const errors: StorageMeasurementError[] = [];
  let count: number | null = null;
  let allocatedBytes: number | null = null;
  let logicalBytes: number | null = null;

  if (entriesResult.status === 'fulfilled') {
    count = entriesResult.value.filter((entry) => (
      entry.isDirectory() && !entry.name.startsWith('.')
    )).length;
  } else {
    errors.push(measurementError('count', entriesResult.reason));
  }

  if (allocatedSizeResult.status === 'fulfilled') {
    try {
      allocatedBytes = parseDuBytes(allocatedSizeResult.value, 'allocated');
    } catch (error) {
      errors.push(measurementError('allocatedBytes', error));
    }
  } else {
    errors.push(measurementError('allocatedBytes', allocatedSizeResult.reason));
  }

  if (logicalSizeResult.status === 'fulfilled') {
    try {
      logicalBytes = parseDuBytes(logicalSizeResult.value, 'logical');
    } catch (error) {
      errors.push(measurementError('logicalBytes', error));
    }
  } else {
    errors.push(measurementError('logicalBytes', logicalSizeResult.reason));
  }

  return {
    path: resolvedPath,
    category: 'workspace',
    presence: 'present',
    count,
    allocatedBytes,
    logicalBytes,
    countAccounting: count === null ? 'unknown' : 'observed',
    allocatedBytesAccounting: allocatedBytes === null ? 'unknown' : 'observed',
    logicalBytesAccounting: logicalBytes === null ? 'unknown' : 'observed',
    errors,
  };
}

export function readCachedDirectoryStorage(targetPath: string): DirectoryStorageTelemetry | null {
  return directoryStorageCache.get(path.resolve(targetPath))?.measurement ?? null;
}

/**
 * Refresh one directory measurement without letting concurrent consumers fan
 * out duplicate `du` walks. A failed refresh preserves the last observed byte
 * count, because stale growth history is safer than erasing it during I/O
 * contention.
 */
export function refreshDirectoryStorage(targetPath: string): Promise<DirectoryStorageTelemetry> {
  const resolvedPath = path.resolve(targetPath);
  const active = directoryStorageRefreshes.get(resolvedPath);
  if (active) return active;

  const refresh = measureDirectoryStorage(resolvedPath).then((measurement) => {
    if (measurement.allocatedBytesAccounting === 'observed') {
      directoryStorageCache.set(resolvedPath, { measurement, observedAt: Date.now() });
    }
    return measurement;
  }).finally(() => {
    directoryStorageRefreshes.delete(resolvedPath);
  });
  directoryStorageRefreshes.set(resolvedPath, refresh);
  return refresh;
}

export function aggregateDirectoryStorage(
  measurements: DirectoryStorageTelemetry[],
): AggregatedStorageTelemetry {
  const observedCount = measurements
    .flatMap((item) => item.count === null ? [] : [item.count])
    .reduce((sum, value) => sum + value, 0);
  const observedAllocatedBytes = measurements
    .flatMap((item) => item.allocatedBytes === null ? [] : [item.allocatedBytes])
    .reduce((sum, value) => sum + value, 0);
  const observedLogicalBytes = measurements
    .flatMap((item) => item.logicalBytes === null ? [] : [item.logicalBytes])
    .reduce((sum, value) => sum + value, 0);
  const unknownCountMeasurements = measurements.filter(
    (item) => item.countAccounting === 'unknown',
  ).length;
  const unknownAllocatedByteMeasurements = measurements.filter(
    (item) => item.allocatedBytesAccounting === 'unknown',
  ).length;
  const unknownLogicalByteMeasurements = measurements.filter(
    (item) => item.logicalBytesAccounting === 'unknown',
  ).length;
  const unknownMeasurements = unknownCountMeasurements
    + unknownAllocatedByteMeasurements
    + unknownLogicalByteMeasurements;
  const observedMeasurements = (measurements.length * 3) - unknownMeasurements;
  const accountingStatus: StorageAccountingStatus = unknownMeasurements === 0
    ? 'observed'
    : observedMeasurements === 0
      ? 'unknown'
      : 'partial';

  return {
    accountingStatus,
    count: unknownCountMeasurements === 0 ? observedCount : null,
    allocatedBytes: unknownAllocatedByteMeasurements === 0 ? observedAllocatedBytes : null,
    logicalBytes: unknownLogicalByteMeasurements === 0 ? observedLogicalBytes : null,
    observedCount,
    observedAllocatedBytes,
    observedLogicalBytes,
    unknownCountMeasurements,
    unknownAllocatedByteMeasurements,
    unknownLogicalByteMeasurements,
    errors: measurements.flatMap((item) => item.errors),
  };
}

function safeBytes(blocks: bigint, blockSize: bigint): number {
  const bytes = blocks * blockSize;
  if (bytes < BigInt(0) || bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('statfs returned a byte count outside the safe integer range.');
  }
  return Number(bytes);
}

async function readStatFs(targetPath: string): Promise<StatFsLike> {
  return statfs(targetPath, { bigint: true });
}

export async function measureHostVolume(
  targetPath: string,
  dependencies: VolumeTelemetryDependencies = {},
): Promise<HostVolumeTelemetry> {
  const resolvedTarget = path.resolve(targetPath);
  const statFsReader = dependencies.readStatFs ?? readStatFs;
  const volumeIdReader = dependencies.readVolumeId ?? (async (candidate: string) => {
    const identity = await stat(candidate, { bigint: true });
    return `device:${identity.dev.toString()}`;
  });
  let probePath = resolvedTarget;

  while (true) {
    try {
      const stats = await statFsReader(probePath);
      const volumeId = await volumeIdReader(probePath);
      return {
        accountingStatus: 'observed',
        targetPath: resolvedTarget,
        probePath,
        volumeId,
        freeBytes: safeBytes(stats.bfree, stats.bsize),
        availableBytes: safeBytes(stats.bavail, stats.bsize),
        totalBytes: safeBytes(stats.blocks, stats.bsize),
        error: null,
      };
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        return {
          accountingStatus: 'unknown',
          targetPath: resolvedTarget,
          probePath: null,
          volumeId: null,
          freeBytes: null,
          availableBytes: null,
          totalBytes: null,
          error: measurementError('hostVolume', error),
        };
      }
      const parent = path.dirname(probePath);
      if (parent === probePath) {
        return {
          accountingStatus: 'unknown',
          targetPath: resolvedTarget,
          probePath: null,
          volumeId: null,
          freeBytes: null,
          availableBytes: null,
          totalBytes: null,
          error: measurementError('hostVolume', error),
        };
      }
      probePath = parent;
    }
  }
}
