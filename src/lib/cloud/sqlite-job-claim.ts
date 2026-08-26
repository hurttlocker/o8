import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import type { ClaimCloudJobInput } from './job-store';

function iso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

/** Atomic lease acquisition shared by cloud workers and background executors. */
export function claimDurableJobRow<Row>(
  sqlite: Database.Database,
  input: ClaimCloudJobInput,
  recoverExpired: (nowMs: number) => void,
): Row | null {
  const nowMs = input.nowMs ?? Date.now();
  const now = iso(nowMs);
  const leaseExpiresAt = nowMs + Math.max(1, Math.floor(input.leaseMs));
  const claim = sqlite.transaction(() => {
    const drain = sqlite.prepare(
      'SELECT boot_id FROM cloud_job_drain_state WHERE team_id = ?',
    ).get(input.teamId) as { boot_id: string } | undefined;
    if (drain?.boot_id === input.bootId) return null;
    if (drain) sqlite.prepare('DELETE FROM cloud_job_drain_state WHERE team_id = ?').run(input.teamId);

    recoverExpired(nowMs);
    const active = sqlite.prepare(
      "SELECT COUNT(*) AS count FROM cloud_jobs WHERE team_id = ? AND status = 'leased'",
    ).get(input.teamId) as { count: number };
    if (active.count >= Math.max(1, Math.floor(input.maxConcurrent ?? Number.MAX_SAFE_INTEGER))) return null;

    const row = sqlite.prepare(`
      SELECT candidate.* FROM cloud_jobs candidate
      WHERE candidate.team_id = ? AND candidate.status = 'pending'
        AND (candidate.available_at IS NULL OR candidate.available_at <= ?)
        AND (candidate.cursor >= ? OR candidate.lease_recovery_count > 0)
        AND (? IS NULL OR candidate.id = ?)
        AND (
          candidate.concurrency_key IS NULL OR (
            SELECT COUNT(*) FROM cloud_jobs active_key
            WHERE active_key.team_id = candidate.team_id
              AND active_key.concurrency_key = candidate.concurrency_key
              AND active_key.status = 'leased'
          ) < MIN(
            COALESCE(candidate.concurrency_limit, 1),
            COALESCE((
              SELECT MIN(active_limit.concurrency_limit) FROM cloud_jobs active_limit
              WHERE active_limit.team_id = candidate.team_id
                AND active_limit.concurrency_key = candidate.concurrency_key
                AND active_limit.status = 'leased'
            ), COALESCE(candidate.concurrency_limit, 1))
          )
        )
      ORDER BY candidate.cursor ASC
      LIMIT 1
    `).get(
      input.teamId,
      nowMs,
      input.cursor,
      input.jobId ?? null,
      input.jobId ?? null,
    ) as { id: string } | undefined;
    if (!row) return null;

    const leaseToken = randomUUID();
    const changed = sqlite.prepare(`
      UPDATE cloud_jobs
      SET status = 'leased', claimed_at = ?, claimed_by = ?, lease_token = ?,
          lease_expires_at = ?, claim_count = claim_count + 1,
          concurrent_count = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(now, input.workerId, leaseToken, leaseExpiresAt, active.count + 1, now, row.id);
    if (changed.changes !== 1) return null;
    sqlite.prepare(`
      INSERT INTO cloud_job_events (job_id, event_type, payload_json, worker_id, created_at)
      VALUES (?, 'claimed', ?, ?, ?)
    `).run(row.id, JSON.stringify({ leaseExpiresAt: iso(leaseExpiresAt) }), input.workerId, now);
    return sqlite.prepare('SELECT * FROM cloud_jobs WHERE id = ?').get(row.id) as Row;
  });
  return claim.immediate();
}
