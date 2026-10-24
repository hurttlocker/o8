import path from 'node:path';
import { getLaneEvents } from '@/lib/lane/registry';
import { isLaneTerminal } from '@/lib/lane/terminal-states';
import { laneOwnsWorktree } from '@/lib/lane/lane-storage-release';
import type { Lane } from '@/lib/lane/types';
import { aggregateDirectoryStorage, refreshDirectoryStorage, type DirectoryStorageTelemetry } from '@/lib/worktree/storage-telemetry';

export interface TerminalWorktreeStorage {
  measuredAt: string;
  accountingStatus: 'observed' | 'partial' | 'unknown';
  checkoutCount: number;
  allocatedBytes: number | null;
  observedAllocatedBytes: number;
  unknownCheckouts: number;
  checkoutsTruncated: boolean;
  checkouts: Array<{
    laneId: string;
    packetId: string;
    status: string;
    worktreePath: string;
    allocatedBytes: number | null;
    reason: string | null;
    detail: string | null;
  }>;
}

/** Explicit status read only: never schedules or grants checkout retirement. */
export async function readTerminalWorktreeStorage(lanes: Lane[]): Promise<TerminalWorktreeStorage> {
  const byPath = new Map<string, Lane>();
  for (const lane of lanes) {
    if (lane.ownership !== 'managed' || !lane.packetId || !lane.worktreePath
      || !isLaneTerminal(lane.status) || !laneOwnsWorktree(lane)) continue;
    const target = path.resolve(lane.worktreePath);
    if (target === path.resolve(lane.repoPath)) continue;
    if (!byPath.has(target)) byPath.set(target, lane);
  }
  const entries = [...byPath.entries()];
  const measurements: DirectoryStorageTelemetry[] = entries.map(([target]) => ({
    path: target, category: 'workspace', presence: 'unknown', count: null,
    allocatedBytes: null, logicalBytes: null, countAccounting: 'unknown',
    allocatedBytesAccounting: 'unknown', logicalBytesAccounting: 'unknown', errors: [],
  }));
  const deadline = Date.now() + 5_000;
  // Bound both concurrency and request time. Existing in-flight measurements
  // settle into the shared telemetry cache; no further walks start after expiry.
  for (let offset = 0; offset < entries.length; offset += 4) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = await Promise.race([
        Promise.all(entries.slice(offset, offset + 4).map(async ([target], index) => {
          measurements[offset + index] = await refreshDirectoryStorage(target);
        })).then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), remainingMs); }),
      ]);
      if (!completed) break;
    } finally {
      clearTimeout(timer);
    }
  }
  const usage = aggregateDirectoryStorage(measurements);
  const retained = entries.flatMap(([target, lane], index) => {
    const measurement = measurements[index];
    if (measurement.presence === 'absent') return [];
    const refusal = getLaneEvents(lane.id, 80).reverse().find(event => (
      event.payload.phase === 'archive_cleanup_held' || event.payload.phase === 'merge_cleanup_skipped'
    ));
    return [{ laneId: lane.id, packetId: lane.packetId!, status: lane.status, worktreePath: target,
      allocatedBytes: measurement.allocatedBytes,
      reason: typeof refusal?.payload.reason === 'string' ? refusal.payload.reason : null,
      detail: typeof refusal?.payload.detail === 'string' ? refusal.payload.detail : null }];
  });
  return {
    measuredAt: new Date().toISOString(),
    accountingStatus: usage.accountingStatus,
    checkoutCount: retained.length,
    allocatedBytes: usage.allocatedBytes,
    observedAllocatedBytes: usage.observedAllocatedBytes,
    unknownCheckouts: usage.unknownAllocatedByteMeasurements,
    checkoutsTruncated: retained.length > 50,
    checkouts: retained.slice(0, 50),
  };
}
