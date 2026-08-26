import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import type { LaunchOptions } from '@/lib/runtimes/types';
import type {
  CloudJob,
  CloudJobDrainStatus,
  CloudJobMetrics,
  CloudJobStatus,
} from './job-store';

export interface SqliteCloudJobRow {
  id: string;
  team_id: string;
  cursor: number;
  idempotency_key: string;
  packet_id: string | null;
  session_id: string | null;
  parent_job_id: string | null;
  launch_json: string;
  status: CloudJobStatus;
  enqueued_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  claim_count: number;
  lease_recovery_count: number;
  execution_attempts: number;
  max_attempts: number;
  last_error: string | null;
  completed_at: string | null;
  updated_at: string;
}

interface SteerControlRow {
  id: string;
  payload_json: string;
}

function iso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function jobFromRow(row: SqliteCloudJobRow): CloudJob {
  return {
    id: row.id,
    teamId: row.team_id,
    cursor: row.cursor,
    idempotencyKey: row.idempotency_key,
    packetId: row.packet_id ?? undefined,
    sessionId: row.session_id || row.id,
    parentJobId: row.parent_job_id ?? undefined,
    launch: JSON.parse(row.launch_json) as LaunchOptions,
    status: row.status,
    enqueuedAt: row.enqueued_at,
    claimedAt: row.claimed_at ?? undefined,
    claimedBy: row.claimed_by ?? undefined,
    leaseToken: row.lease_token ?? undefined,
    leaseExpiresAt: row.lease_expires_at == null ? undefined : iso(row.lease_expires_at),
    claimCount: row.claim_count,
    leaseRecoveryCount: row.lease_recovery_count,
    executionAttempts: row.execution_attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error ?? undefined,
    completedAt: row.completed_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function steerMessage(payloadJson: string): string {
  try {
    const payload = JSON.parse(payloadJson) as unknown;
    if (typeof payload === 'string') return payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
    const message = (payload as Record<string, unknown>).message;
    return typeof message === 'string' ? message : '';
  } catch {
    return '';
  }
}

export function promoteSteerControls(
  sqlite: Database.Database,
  row: SqliteCloudJobRow,
  nowMs: number,
): CloudJob | undefined {
  const controls = sqlite.prepare(`
    SELECT id, payload_json FROM cloud_job_controls
    WHERE team_id = ? AND job_id = ? AND control_type = 'steer'
      AND status IN ('pending', 'delivered')
    ORDER BY sequence ASC
  `).all(row.team_id, row.id) as SteerControlRow[];
  if (controls.length === 0) return undefined;

  const first = controls[0];
  const jobId = randomUUID();
  const now = iso(nowMs);
  const next = sqlite.prepare(
    'SELECT COALESCE(MAX(cursor), 0) + 1 AS cursor FROM cloud_jobs WHERE team_id = ?',
  ).get(row.team_id) as { cursor: number };
  const launch = {
    ...(JSON.parse(row.launch_json) as LaunchOptions),
    prompt: controls.map((control) => steerMessage(control.payload_json).trim()).filter(Boolean).join('\n\n')
      || 'Continue the prior cloud session.',
    clientMutationId: `cloud-follow-up:${first.id}`,
  };
  sqlite.prepare(`
    INSERT INTO cloud_jobs (
      id, team_id, cursor, idempotency_key, packet_id, session_id, parent_job_id,
      launch_json, status, enqueued_at, claim_count, lease_recovery_count,
      execution_attempts, max_attempts, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, 0, 0, ?, ?)
  `).run(
    jobId,
    row.team_id,
    next.cursor,
    `cloud-follow-up:${first.id}`,
    row.packet_id,
    row.session_id || row.id,
    row.id,
    JSON.stringify(launch),
    now,
    row.max_attempts,
    now,
  );
  const controlIds = controls.map((control) => control.id);
  sqlite.prepare(`
    INSERT INTO cloud_job_events (job_id, event_type, payload_json, created_at)
    VALUES (?, 'accepted', ?, ?)
  `).run(jobId, JSON.stringify({
    packetId: row.packet_id,
    sessionId: row.session_id || row.id,
    parentJobId: row.id,
    sourceControlIds: controlIds,
  }), now);
  const placeholders = controlIds.map(() => '?').join(', ');
  sqlite.prepare(`
    UPDATE cloud_job_controls
    SET status = 'follow_up', follow_up_job_id = ?, delivery_token = NULL,
        delivery_expires_at = NULL, updated_at = ?
    WHERE id IN (${placeholders})
  `).run(jobId, now, ...controlIds);
  sqlite.prepare(`
    INSERT INTO cloud_job_events (job_id, event_type, payload_json, created_at)
    VALUES (?, 'follow_up_queued', ?, ?)
  `).run(row.id, JSON.stringify({ followUpJobId: jobId, controlIds }), now);
  return jobFromRow(sqlite.prepare('SELECT * FROM cloud_jobs WHERE id = ?').get(jobId) as SqliteCloudJobRow);
}

export function cancelCloudJob(
  sqlite: Database.Database,
  row: SqliteCloudJobRow,
  nowMs: number,
  detail: { controlId?: string; workerId?: string } = {},
): boolean {
  const now = iso(nowMs);
  const changed = sqlite.prepare(`
    UPDATE cloud_jobs
    SET status = 'cancelled', claimed_at = NULL, claimed_by = NULL,
        lease_token = NULL, lease_expires_at = NULL,
        completed_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('pending', 'leased')
  `).run(now, now, row.id);
  if (changed.changes !== 1) return false;
  sqlite.prepare(`
    INSERT INTO cloud_job_events (job_id, event_type, payload_json, worker_id, created_at)
    VALUES (?, 'cancelled', ?, ?, ?)
  `).run(row.id, JSON.stringify({ controlId: detail.controlId ?? null }), detail.workerId ?? null, now);
  return true;
}

function drainStatus(
  sqlite: Database.Database,
  teamId: string,
  bootId: string,
): CloudJobDrainStatus {
  const row = sqlite.prepare(
    'SELECT boot_id, started_at FROM cloud_job_drain_state WHERE team_id = ?',
  ).get(teamId) as { boot_id: string; started_at: string } | undefined;
  const counts = sqlite.prepare(`
    SELECT
      SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS active_leases,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_jobs
    FROM cloud_jobs WHERE team_id = ?
  `).get(teamId) as { active_leases: number | null; pending_jobs: number | null };
  return {
    draining: row?.boot_id === bootId,
    bootId: row?.boot_id,
    startedAt: row?.started_at,
    activeLeases: counts.active_leases ?? 0,
    pendingJobs: counts.pending_jobs ?? 0,
  };
}

export function beginCloudJobDrain(
  sqlite: Database.Database,
  teamId: string,
  bootId: string,
  nowMs: number,
): CloudJobDrainStatus {
  const now = iso(nowMs);
  sqlite.prepare(`
    INSERT INTO cloud_job_drain_state (team_id, boot_id, started_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(team_id) DO UPDATE SET
      boot_id = excluded.boot_id,
      started_at = CASE
        WHEN cloud_job_drain_state.boot_id = excluded.boot_id THEN cloud_job_drain_state.started_at
        ELSE excluded.started_at
      END,
      updated_at = excluded.updated_at
  `).run(teamId, bootId, now, now);
  return drainStatus(sqlite, teamId, bootId);
}

export function finishCloudJobDrain(
  sqlite: Database.Database,
  teamId: string,
  bootId: string,
  nowMs: number,
): CloudJobDrainStatus {
  const now = iso(nowMs);
  beginCloudJobDrain(sqlite, teamId, bootId, nowMs);
  const rows = sqlite.prepare(`
    SELECT * FROM cloud_jobs WHERE team_id = ? AND status = 'leased' ORDER BY cursor ASC
  `).all(teamId) as SqliteCloudJobRow[];
  for (const row of rows) {
    sqlite.prepare(`
      UPDATE cloud_jobs
      SET status = 'pending', claimed_at = NULL, claimed_by = NULL,
          lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'leased' AND lease_token = ?
    `).run(now, row.id, row.lease_token);
    sqlite.prepare(`
      INSERT INTO cloud_job_events (job_id, event_type, payload_json, worker_id, created_at)
      VALUES (?, 'lease_released', ?, ?, ?)
    `).run(row.id, JSON.stringify({ reason: 'app_restart' }), row.claimed_by, now);
  }
  return drainStatus(sqlite, teamId, bootId);
}

export function readCloudJobDrainStatus(
  sqlite: Database.Database,
  teamId: string,
  bootId: string,
): CloudJobDrainStatus {
  return drainStatus(sqlite, teamId, bootId);
}

export function readCloudJobMetrics(
  sqlite: Database.Database,
  teamId: string,
  jobId: string,
): CloudJobMetrics | undefined {
  const row = sqlite.prepare(
    'SELECT * FROM cloud_jobs WHERE team_id = ? AND id = ?',
  ).get(teamId, jobId) as SqliteCloudJobRow | undefined;
  if (!row) return undefined;
  const firstClaim = sqlite.prepare(`
    SELECT created_at FROM cloud_job_events
    WHERE job_id = ? AND event_type = 'claimed' ORDER BY id ASC LIMIT 1
  `).get(jobId) as { created_at: string } | undefined;
  const enqueuedMs = Date.parse(row.enqueued_at);
  const firstClaimMs = firstClaim ? Date.parse(firstClaim.created_at) : Number.NaN;
  const completedMs = row.completed_at ? Date.parse(row.completed_at) : Number.NaN;
  return {
    jobId: row.id,
    status: row.status,
    queueWaitMs: Number.isFinite(firstClaimMs) && Number.isFinite(enqueuedMs)
      ? Math.max(0, firstClaimMs - enqueuedMs)
      : null,
    claimCount: row.claim_count,
    leaseRecoveryCount: row.lease_recovery_count,
    executionAttempts: row.execution_attempts,
    terminalLatencyMs: Number.isFinite(completedMs) && Number.isFinite(enqueuedMs)
      ? Math.max(0, completedMs - enqueuedMs)
      : null,
  };
}
