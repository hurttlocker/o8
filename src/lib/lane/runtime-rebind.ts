import { getSqlite } from '@/lib/db';
import { recordLaneEvent } from './events';
import { getLane } from './registry';
import type { Lane, LaneRuntime } from './types';

/** System-only runtime rebinding for an operator-authorized cross-house retry. */
export function rebindLaneRuntime(
  laneId: string,
  runtime: LaneRuntime,
  payload: Record<string, unknown>,
): Lane | null {
  const lane = getLane(laneId);
  if (!lane) return null;
  const timestamp = new Date().toISOString();
  getSqlite().prepare(`
    UPDATE lanes
    SET runtime = ?, session_key = NULL, updated_at = ?
    WHERE id = ?
  `).run(runtime, timestamp, laneId);
  recordLaneEvent(laneId, 'update', 'system', {
    runtime,
    sessionKey: null,
    ...payload,
  });
  return getLane(laneId);
}
