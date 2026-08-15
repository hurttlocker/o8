import { describe, expect, it, vi } from 'vitest';

import {
  aggregateDirectoryStorage,
  measureDirectoryStorage,
  measureHostVolume,
} from './storage-telemetry';

function directory() {
  return { isDirectory: () => true };
}

function entry(name: string, isDirectory = true) {
  return { name, isDirectory: () => isDirectory };
}

function errno(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe('worktree storage telemetry', () => {
  it('reports absent worktree roots as observed zero', async () => {
    const result = await measureDirectoryStorage('/missing/worktrees', {
      statPath: async () => { throw errno('ENOENT'); },
    });

    expect(result).toMatchObject({
      category: 'workspace',
      presence: 'absent',
      count: 0,
      allocatedBytes: 0,
      logicalBytes: 0,
      countAccounting: 'observed',
      allocatedBytesAccounting: 'observed',
      logicalBytesAccounting: 'observed',
      errors: [],
    });
  });

  it('keeps allocated and apparent worktree sizes as separate measurements', async () => {
    const result = await measureDirectoryStorage('/worktrees', {
      statPath: async () => directory(),
      readDirectory: async () => [
        entry('packet-a'),
        entry('packet-b'),
        entry('.meta'),
        entry('receipt.json', false),
      ],
      runAllocatedSize: async () => '12\t/worktrees\n',
      runLogicalSize: async () => '42\t/worktrees\n',
    });

    expect(result).toMatchObject({
      presence: 'present',
      count: 2,
      allocatedBytes: 12 * 1024,
      logicalBytes: 42 * 1024,
      countAccounting: 'observed',
      allocatedBytesAccounting: 'observed',
      logicalBytesAccounting: 'observed',
      errors: [],
    });
  });

  it('keeps failed logical-size accounting unknown instead of converting it to zero', async () => {
    const measurement = await measureDirectoryStorage('/worktrees', {
      statPath: async () => directory(),
      readDirectory: async () => [entry('packet-a')],
      runAllocatedSize: async () => '12\t/worktrees\n',
      runLogicalSize: async () => { throw errno('EACCES', 'permission denied'); },
    });
    const aggregate = aggregateDirectoryStorage([measurement]);

    expect(measurement.logicalBytes).toBeNull();
    expect(measurement.logicalBytesAccounting).toBe('unknown');
    expect(aggregate).toMatchObject({
      accountingStatus: 'partial',
      count: 1,
      allocatedBytes: 12 * 1024,
      logicalBytes: null,
      observedCount: 1,
      observedAllocatedBytes: 12 * 1024,
      observedLogicalBytes: 0,
      unknownAllocatedByteMeasurements: 0,
      unknownLogicalByteMeasurements: 1,
    });
  });

  it('reads exact host-volume byte counts and walks only through missing ancestors', async () => {
    const readStatFs = vi.fn(async (targetPath: string) => {
      if (targetPath === '/missing/worktrees') throw errno('ENOENT');
      return {
        bsize: BigInt(4),
        blocks: BigInt(100),
        bfree: BigInt(30),
        bavail: BigInt(20),
      };
    });

    const result = await measureHostVolume('/missing/worktrees', {
      readStatFs,
      readVolumeId: async () => 'device:test-volume',
    });

    expect(readStatFs.mock.calls.map(([targetPath]) => targetPath)).toEqual([
      '/missing/worktrees',
      '/missing',
    ]);
    expect(result).toMatchObject({
      accountingStatus: 'observed',
      probePath: '/missing',
      volumeId: 'device:test-volume',
      freeBytes: 120,
      availableBytes: 80,
      totalBytes: 400,
      error: null,
    });
  });

  it('keeps host capacity unknown when statfs cannot measure it', async () => {
    const result = await measureHostVolume('/private/worktrees', {
      readStatFs: async () => { throw errno('EACCES', 'permission denied'); },
    });

    expect(result).toMatchObject({
      accountingStatus: 'unknown',
      probePath: null,
      freeBytes: null,
      availableBytes: null,
      totalBytes: null,
      error: { metric: 'hostVolume', code: 'EACCES' },
    });
  });
});
