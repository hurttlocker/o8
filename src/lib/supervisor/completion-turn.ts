import { getSqlite } from '@/lib/db';
import { getLane } from '@/lib/lane/registry';
import { packetSteerHoldReason } from '@/lib/lane/packet-stop-hold';
import type { Lane } from '@/lib/lane/types';

export class SupersededCompletionError extends Error {
  constructor() {
    super('Completion superseded by a newer turn or operator lifecycle change.');
  }
}

function turnCursor(laneId: string): number {
  const row = getSqlite().prepare(`
    SELECT rowid FROM lane_events WHERE lane_id = ? AND verb IN (
      'steered_packet', 'steer_run_admitted', 'steer_failed', 'runtime_process_exit'
    ) ORDER BY rowid DESC LIMIT 1
  `).get(laneId) as { rowid: number } | undefined;
  return row?.rowid ?? 0;
}

/** Durable insertion order also distinguishes two turns in one millisecond. */
export function createCompletionTurnGuard(lane: Lane) {
  const cursor = turnCursor(lane.id);
  function check(): void {
    const current = getLane(lane.id);
    if (!current || current.sessionKey !== lane.sessionKey || current.packetId !== lane.packetId
      || ['paused', 'merging', 'completed', 'archived'].includes(current.status)
      || (current.packetId && packetSteerHoldReason(current.packetId))
      || turnCursor(lane.id) !== cursor) {
      throw new SupersededCompletionError();
    }
  }
  return {
    check,
    async wait<T>(action: () => Promise<T>): Promise<T> {
      check();
      try {
        return await action();
      } finally {
        check();
      }
    },
  };
}
