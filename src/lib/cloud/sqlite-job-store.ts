import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import { getSqlite } from '@/lib/db';
import type { LaunchOptions } from '@/lib/runtimes/types';
import {
  CloudPacketActiveError,
  type AppendCloudJobEventInput,
  type AppendCloudJobEventResult,
  type ClaimCloudJobInput,
  type CloudJob,
  type CloudJobEvent,
  type CloudJobEventType,
  type CloudJobStatus,
  type CloudJobStore,
  type EnqueueCloudJobInput,
} from './job-store';

interface CloudJobRow {
  id: string;
  team_id: string;
  cursor: number;
  idempotency_key: string;
  packet_id: string | null;
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

interface CloudJobEventRow {
  id: number;
  job_id: string;
  event_type: CloudJobEventType;
  payload_json: string;
  worker_id: string | null;
  created_at: string;
}

function iso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function parseLaunch(value: string): LaunchOptions {
  return JSON.parse(value) as LaunchOptions;
}

function parsePayload(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function jobFromRow(row: CloudJobRow): CloudJob {
  return {
    id: row.id,
    teamId: row.team_id,
    cursor: row.cursor,
    idempotencyKey: row.idempotency_key,
    packetId: row.packet_id ?? undefined,
    launch: parseLaunch(row.launch_json),
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

function eventFromRow(row: CloudJobEventRow): CloudJobEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    type: row.event_type,
    payload: parsePayload(row.payload_json),
    workerId: row.worker_id ?? undefined,
    createdAt: row.created_at,
  };
}

function messageFromPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'Cloud worker execution failed.';
  const record = payload as Record<string, unknown>;
  for (const key of ['message', 'error', 'reason']) {
    if (typeof record[key] === 'string' && record[key]) return record[key];
  }
  return 'Cloud worker execution failed.';
}

export class SqliteCloudJobStore implements CloudJobStore {
  constructor(private readonly sqliteProvider: () => Database.Database = getSqlite) {}

  enqueue(input: EnqueueCloudJobInput): CloudJob {
    const sqlite = this.sqliteProvider();
    const launchJson = JSON.stringify(input.launch);
    const nowMs = input.nowMs ?? Date.now();
    const now = iso(nowMs);
    const packetId = input.packetId?.trim() || null;
    const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? 3));
    const enqueue = sqlite.transaction(() => {
      const existing = sqlite.prepare(
        'SELECT * FROM cloud_jobs WHERE team_id = ? AND idempotency_key = ?',
      ).get(input.teamId, input.idempotencyKey) as CloudJobRow | undefined;
      if (existing) {
        if (existing.launch_json !== launchJson) {
          throw new Error(`Cloud job idempotency key ${input.idempotencyKey} was reused with a different launch.`);
        }
        return jobFromRow(existing);
      }

      const next = sqlite.prepare(
        'SELECT COALESCE(MAX(cursor), 0) + 1 AS cursor FROM cloud_jobs WHERE team_id = ?',
      ).get(input.teamId) as { cursor: number };
      sqlite.prepare(`
        INSERT INTO cloud_jobs (
          id, team_id, cursor, idempotency_key, packet_id, launch_json, status,
          enqueued_at, claim_count, lease_recovery_count, execution_attempts,
          max_attempts, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, 0, 0, ?, ?)
      `).run(
        input.id,
        input.teamId,
        next.cursor,
        input.idempotencyKey,
        packetId,
        launchJson,
        now,
        maxAttempts,
        now,
      );
      sqlite.prepare(`
        INSERT INTO cloud_job_events (job_id, event_type, payload_json, created_at)
        VALUES (?, 'accepted', ?, ?)
      `).run(input.id, JSON.stringify({ packetId }), now);
      return jobFromRow(sqlite.prepare('SELECT * FROM cloud_jobs WHERE id = ?').get(input.id) as CloudJobRow);
    });

    try {
      return enqueue.immediate();
    } catch (error) {
      if (packetId) {
        const active = sqlite.prepare(`
          SELECT * FROM cloud_jobs
          WHERE team_id = ? AND packet_id = ? AND status IN ('pending', 'leased')
          LIMIT 1
        `).get(input.teamId, packetId) as CloudJobRow | undefined;
        if (active) throw new CloudPacketActiveError(jobFromRow(active));
      }
      throw error;
    }
  }

  claimNext(input: ClaimCloudJobInput): CloudJob | null {
    const sqlite = this.sqliteProvider();
    const nowMs = input.nowMs ?? Date.now();
    const now = iso(nowMs);
    const leaseExpiresAt = nowMs + Math.max(1, Math.floor(input.leaseMs));
    const claim = sqlite.transaction(() => {
      this.recoverExpiredLeasesWithin(sqlite, input.teamId, nowMs);
      const row = sqlite.prepare(`
        SELECT * FROM cloud_jobs
        WHERE team_id = ? AND status = 'pending'
          AND (cursor >= ? OR lease_recovery_count > 0)
        ORDER BY cursor ASC
        LIMIT 1
      `).get(input.teamId, input.cursor) as CloudJobRow | undefined;
      if (!row) return null;

      const leaseToken = randomUUID();
      const changed = sqlite.prepare(`
        UPDATE cloud_jobs
        SET status = 'leased', claimed_at = ?, claimed_by = ?, lease_token = ?,
            lease_expires_at = ?, claim_count = claim_count + 1, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(now, input.workerId, leaseToken, leaseExpiresAt, now, row.id);
      if (changed.changes !== 1) return null;
      sqlite.prepare(`
        INSERT INTO cloud_job_events (job_id, event_type, payload_json, worker_id, created_at)
        VALUES (?, 'claimed', ?, ?, ?)
      `).run(row.id, JSON.stringify({ leaseExpiresAt: iso(leaseExpiresAt) }), input.workerId, now);
      return jobFromRow(sqlite.prepare('SELECT * FROM cloud_jobs WHERE id = ?').get(row.id) as CloudJobRow);
    });
    return claim.immediate();
  }

  appendEvent(input: AppendCloudJobEventInput): AppendCloudJobEventResult {
    const sqlite = this.sqliteProvider();
    const nowMs = input.nowMs ?? Date.now();
    const now = iso(nowMs);
    const append = sqlite.transaction((): AppendCloudJobEventResult => {
      const row = sqlite.prepare(
        'SELECT * FROM cloud_jobs WHERE team_id = ? AND id = ?',
      ).get(input.teamId, input.jobId) as CloudJobRow | undefined;
      if (!row) return { accepted: false, reason: 'job_not_found' };
      if (row.status !== 'leased') {
        return { accepted: false, reason: 'job_not_leased', job: jobFromRow(row) };
      }
      if (row.lease_token !== input.leaseToken || row.claimed_by !== input.workerId) {
        return { accepted: false, reason: 'lease_mismatch', job: jobFromRow(row) };
      }
      if (row.lease_expires_at == null || row.lease_expires_at <= nowMs) {
        this.recoverLeaseWithin(sqlite, row, nowMs);
        const recovered = sqlite.prepare('SELECT * FROM cloud_jobs WHERE id = ?').get(row.id) as CloudJobRow;
        return { accepted: false, reason: 'lease_expired', job: jobFromRow(recovered) };
      }

      const event = sqlite.prepare(`
        INSERT INTO cloud_job_events (job_id, event_type, payload_json, worker_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(row.id, input.type, JSON.stringify(input.payload ?? null), input.workerId, now);

      if (input.type === 'completed') {
        sqlite.prepare(`
          UPDATE cloud_jobs
          SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
              completed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'leased' AND lease_token = ?
        `).run(now, now, row.id, input.leaseToken);
      } else if (input.type === 'errored') {
        const executionAttempts = row.execution_attempts + 1;
        const parked = executionAttempts >= row.max_attempts;
        sqlite.prepare(`
          UPDATE cloud_jobs
          SET status = ?, execution_attempts = ?, last_error = ?, claimed_at = NULL,
              claimed_by = NULL, lease_token = NULL, lease_expires_at = NULL,
              completed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'leased' AND lease_token = ?
        `).run(
          parked ? 'parked' : 'pending',
          executionAttempts,
          messageFromPayload(input.payload),
          parked ? now : null,
          now,
          row.id,
          input.leaseToken,
        );
      } else {
        const leaseExpiresAt = nowMs + Math.max(1, Math.floor(input.leaseMs));
        sqlite.prepare(`
          UPDATE cloud_jobs
          SET lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND status = 'leased' AND lease_token = ?
        `).run(leaseExpiresAt, now, row.id, input.leaseToken);
      }

      const updated = sqlite.prepare('SELECT * FROM cloud_jobs WHERE id = ?').get(row.id) as CloudJobRow;
      return {
        accepted: true,
        eventId: Number(event.lastInsertRowid),
        job: jobFromRow(updated),
      };
    });
    return append.immediate();
  }

  recoverExpiredLeases(teamId: string, nowMs: number = Date.now()): number {
    const sqlite = this.sqliteProvider();
    const recover = sqlite.transaction(() => this.recoverExpiredLeasesWithin(sqlite, teamId, nowMs));
    return recover.immediate();
  }

  cancel(teamId: string, jobId: string, nowMs: number = Date.now()): CloudJob | undefined {
    const sqlite = this.sqliteProvider();
    const now = iso(nowMs);
    const cancel = sqlite.transaction(() => {
      const row = sqlite.prepare(
        'SELECT * FROM cloud_jobs WHERE team_id = ? AND id = ?',
      ).get(teamId, jobId) as CloudJobRow | undefined;
      if (!row) return undefined;
      if (row.status === 'pending' || row.status === 'leased') {
        sqlite.prepare(`
          UPDATE cloud_jobs
          SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
              completed_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('pending', 'leased')
        `).run(now, now, jobId);
        sqlite.prepare(`
          INSERT INTO cloud_job_events (job_id, event_type, payload_json, created_at)
          VALUES (?, 'cancelled', '{}', ?)
        `).run(jobId, now);
      }
      return jobFromRow(sqlite.prepare('SELECT * FROM cloud_jobs WHERE id = ?').get(jobId) as CloudJobRow);
    });
    return cancel.immediate();
  }

  get(teamId: string, jobId: string): CloudJob | undefined {
    const row = this.sqliteProvider().prepare(
      'SELECT * FROM cloud_jobs WHERE team_id = ? AND id = ?',
    ).get(teamId, jobId) as CloudJobRow | undefined;
    return row ? jobFromRow(row) : undefined;
  }

  list(teamId: string, limit: number = 500): CloudJob[] {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 5_000);
    const rows = this.sqliteProvider().prepare(`
      SELECT * FROM cloud_jobs
      WHERE team_id = ?
      ORDER BY cursor DESC
      LIMIT ?
    `).all(teamId, safeLimit) as CloudJobRow[];
    return rows.map(jobFromRow);
  }

  readEvents(
    teamId: string,
    jobId: string,
    sinceId: number = 0,
    limit: number = 500,
  ): CloudJobEvent[] {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 5_000);
    const rows = this.sqliteProvider().prepare(`
      SELECT event.id, event.job_id, event.event_type, event.payload_json,
             event.worker_id, event.created_at
      FROM cloud_job_events event
      JOIN cloud_jobs job ON job.id = event.job_id
      WHERE job.team_id = ? AND job.id = ? AND event.id > ?
      ORDER BY event.id ASC
      LIMIT ?
    `).all(teamId, jobId, Math.max(0, Math.floor(sinceId)), safeLimit) as CloudJobEventRow[];
    return rows.map(eventFromRow);
  }

  private recoverExpiredLeasesWithin(
    sqlite: Database.Database,
    teamId: string,
    nowMs: number,
  ): number {
    const rows = sqlite.prepare(`
      SELECT * FROM cloud_jobs
      WHERE team_id = ? AND status = 'leased' AND lease_expires_at <= ?
      ORDER BY cursor ASC
    `).all(teamId, nowMs) as CloudJobRow[];
    let recovered = 0;
    for (const row of rows) {
      if (this.recoverLeaseWithin(sqlite, row, nowMs)) recovered += 1;
    }
    return recovered;
  }

  private recoverLeaseWithin(sqlite: Database.Database, row: CloudJobRow, nowMs: number): boolean {
    const now = iso(nowMs);
    const changed = sqlite.prepare(`
      UPDATE cloud_jobs
      SET status = 'pending', claimed_at = NULL, claimed_by = NULL,
          lease_token = NULL, lease_expires_at = NULL,
          lease_recovery_count = lease_recovery_count + 1, updated_at = ?
      WHERE id = ? AND status = 'leased' AND lease_token = ? AND lease_expires_at <= ?
    `).run(now, row.id, row.lease_token, nowMs);
    if (changed.changes !== 1) return false;
    sqlite.prepare(`
      INSERT INTO cloud_job_events (job_id, event_type, payload_json, worker_id, created_at)
      VALUES (?, 'lease_recovered', ?, ?, ?)
    `).run(
      row.id,
      JSON.stringify({ expiredAt: row.lease_expires_at == null ? null : iso(row.lease_expires_at) }),
      row.claimed_by,
      now,
    );
    return true;
  }
}
