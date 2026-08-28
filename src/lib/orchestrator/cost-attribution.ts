import { getSqlite } from '@/lib/db';

type AttemptContext = {
  packetId?: string | null;
  laneId?: string | null;
};

/**
 * Derive the one-based packet attempt from durable lane events.
 *
 * A successful session launch starts an attempt. A warm-session steer starts
 * another attempt without producing a new session key. Fresh reruns create a
 * new lane whose open event keeps the packet id, so their launch is counted
 * across the packet's full lane history.
 */
export function derivePacketAttemptIndex(context: AttemptContext): number {
  const packetId = context.packetId?.trim() || null;
  const laneId = context.laneId?.trim() || null;
  if (!packetId && !laneId) return 1;

  const sqlite = getSqlite();
  const laneIds = new Set<string>(laneId ? [laneId] : []);
  if (packetId) {
    const openRows = sqlite.prepare(`
      SELECT lane_id FROM lane_events
      WHERE verb = 'open_lane'
        AND json_extract(payload_json, '$.packetId') = ?
    `).all(packetId) as Array<{ lane_id: string }>;
    for (const row of openRows) laneIds.add(row.lane_id);
    const currentRows = sqlite.prepare('SELECT id FROM lanes WHERE packet_id = ?').all(packetId) as Array<{ id: string }>;
    for (const row of currentRows) laneIds.add(row.id);
  }
  if (laneIds.size === 0) return 1;

  const placeholders = [...laneIds].map(() => '?').join(', ');
  const row = sqlite.prepare(`
    WITH relevant_events AS (
      SELECT id, lane_id, verb, payload_json, timestamp
      FROM lane_events
      WHERE lane_id IN (${placeholders})
        AND (
          verb IN ('session_launched', 'steered_packet')
          OR (verb = 'worker_fallback' AND json_extract(payload_json, '$.status') = 'redispatched')
          OR (
            verb = 'status_change'
            AND json_extract(payload_json, '$.eventLabel') IN (
              'session_launched',
              'session_launch_recovered',
              'worker_quota_fallback_launched'
            )
          )
        )
    ), ordered_launch_signals AS (
      SELECT
        lane_id,
        julianday(timestamp) * 86400000 AS timestamp_ms,
        LAG(julianday(timestamp) * 86400000) OVER (
          PARTITION BY lane_id ORDER BY timestamp, id
        ) AS previous_timestamp_ms
      FROM relevant_events
      WHERE verb != 'steered_packet'
    ), launch_windows AS (
      SELECT COUNT(*) AS launches
      FROM ordered_launch_signals
      WHERE previous_timestamp_ms IS NULL OR timestamp_ms - previous_timestamp_ms > 1000
    )
    SELECT
      (SELECT launches FROM launch_windows)
      + (SELECT COUNT(*) FROM relevant_events WHERE verb = 'steered_packet') AS attempts
  `).get(...laneIds) as { attempts: number } | undefined;

  return Math.max(1, row?.attempts ?? 0);
}
