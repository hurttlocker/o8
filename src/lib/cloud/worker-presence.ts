import 'server-only';

import { getSqlite } from '@/lib/db';
import { listCloudWorkerKeys } from './worker-auth';

const CONNECTED_WINDOW_MS = 60_000;
const RETENTION_MS = 24 * 60 * 60_000;
const MAX_WORKERS_PER_KEY = 32;

export interface ConnectedCloudWorker {
  workerId: string;
  lastSeenAt: string;
}

/** Only a successfully authenticated poll or accepted leased event may call this. */
export function recordCloudWorkerPresence(input: {
  teamId: string;
  keyId: string;
  workerId: string;
  nowMs?: number;
}): void {
  const nowMs = input.nowMs ?? Date.now();
  const sqlite = getSqlite();
  sqlite.transaction(() => {
    const inserted = sqlite.prepare(`
      INSERT OR IGNORE INTO cloud_worker_presence (team_id, key_id, worker_id, last_seen_at)
      VALUES (?, ?, ?, ?)
    `).run(input.teamId, input.keyId, input.workerId, nowMs);
    if (inserted.changes === 0) {
      sqlite.prepare(`
        UPDATE cloud_worker_presence SET last_seen_at = ?
        WHERE team_id = ? AND key_id = ? AND worker_id = ?
      `).run(nowMs, input.teamId, input.keyId, input.workerId);
      return;
    }
    sqlite.prepare('DELETE FROM cloud_worker_presence WHERE last_seen_at < ?')
      .run(nowMs - RETENTION_MS);
    sqlite.prepare(`
      DELETE FROM cloud_worker_presence
      WHERE team_id = ? AND key_id = ? AND worker_id NOT IN (
        SELECT worker_id FROM cloud_worker_presence
        WHERE team_id = ? AND key_id = ?
        ORDER BY last_seen_at DESC, worker_id DESC LIMIT ?
      )
    `).run(input.teamId, input.keyId, input.teamId, input.keyId, MAX_WORKERS_PER_KEY);
  })();
}

/** Revoked keys and stale sightings cannot make a worker appear connected. */
export function listConnectedCloudWorkers(nowMs = Date.now(), teamId?: string): ConnectedCloudWorker[] {
  const activeKeys = listCloudWorkerKeys().filter((key) => !key.revokedAt && (!teamId || key.teamId === teamId));
  const query = getSqlite().prepare(`
    SELECT worker_id AS workerId, last_seen_at AS lastSeenAt
    FROM cloud_worker_presence
    WHERE team_id = ? AND key_id = ? AND last_seen_at >= ?
    ORDER BY last_seen_at DESC, worker_id DESC
    LIMIT ?
  `);
  const buckets = activeKeys.map((key) => query.all(
    key.teamId, key.id, nowMs - CONNECTED_WINDOW_MS, MAX_WORKERS_PER_KEY,
  ) as Array<{
    workerId: string;
    lastSeenAt: number;
  }>);
  const seen = new Set<string>();
  const connected: ConnectedCloudWorker[] = [];
  for (let index = 0; index < MAX_WORKERS_PER_KEY; index += 1) {
    for (const bucket of buckets) {
      const row = bucket[index];
      if (!row || seen.has(row.workerId)) continue;
      seen.add(row.workerId);
      connected.push({ workerId: row.workerId, lastSeenAt: new Date(row.lastSeenAt).toISOString() });
    }
  }
  return connected.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}
