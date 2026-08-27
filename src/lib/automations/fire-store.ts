import { createHash, randomUUID } from 'node:crypto';

import { SqliteCloudJobStore } from '@/lib/cloud/sqlite-job-store';
import type { CloudJob } from '@/lib/cloud/job-store';
import { getSqlite } from '@/lib/db';
import { computeNextRunAt, computePreviousRunAt } from './cron';
import type { AutomationSourceEvent } from './source-events';

export type AutomationFireSource = 'scheduled' | 'manual' | 'watch';
export type AutomationWatchActionKind = 'dispatch' | 'notify' | 'steer' | 'approval';
export type AutomationFireStatus =
  | 'pending'
  | 'leased'
  | 'retrying'
  | 'recovered'
  | 'succeeded'
  | 'skipped_precheck'
  | 'precheck_error'
  | 'parked'
  | 'cancelled';

export type AutomationPrecheckStatus =
  | 'none'
  | 'pending'
  | 'running'
  | 'passed'
  | 'skipped'
  | 'error'
  | 'bypassed';

export interface AutomationFire {
  id: string;
  automationId: string;
  executionJobId: string;
  source: AutomationFireSource;
  slotMs: number | null;
  idempotencyKey: string;
  repoPath: string;
  repoConcurrencyLimit: number;
  status: AutomationFireStatus;
  scheduledAt: number;
  persistedAt: number;
  claimedAt: number | null;
  claimedBy: string | null;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  claimCount: number;
  attemptCount: number;
  recoveryCount: number;
  maxAttempts: number;
  nextAttemptAt: number | null;
  laneId: string | null;
  missionId: string | null;
  resultNote: string | null;
  completedAt: number | null;
  scheduleDelayMs: number | null;
  queueDelayMs: number | null;
  executionMs: number | null;
  concurrentCount: number | null;
  duplicateCount: number;
  precheckCommand: string | null;
  precheckTimeoutMs: number | null;
  precheckBypassed: boolean;
  precheckStatus: AutomationPrecheckStatus;
  precheckStartedAt: number | null;
  precheckCompletedAt: number | null;
  precheckDurationMs: number | null;
  precheckExitCode: number | null;
  precheckStdoutTail: string | null;
  precheckStderrTail: string | null;
  precheckErrorMessage: string | null;
  sourceEventId: number | null;
  sourceKind: string | null;
  sourceId: string | null;
  sourceEventType: string | null;
  sourceFingerprint: string | null;
  sourcePayload: Record<string, unknown> | null;
  actionKind: AutomationWatchActionKind;
  targetLaneId: string | null;
  updatedAt: number;
}

export interface AutomationFireMetrics {
  count: number;
  scheduleDelayMs: { p50: number | null; p95: number | null };
  queueDelayMs: { p50: number | null; p95: number | null };
  executionMs: { p50: number | null; p95: number | null };
  maxConcurrentFires: number;
  duplicateFireCount: number;
}

interface AutomationFireRow {
  id: string;
  automation_id: string;
  execution_job_id: string;
  source: Exclude<AutomationFireSource, 'watch'>;
  slot_ms: number | null;
  idempotency_key: string;
  repo_path: string;
  repo_concurrency_limit: number;
  status: AutomationFireStatus;
  scheduled_at: number;
  persisted_at: number;
  lane_id: string | null;
  mission_id: string | null;
  result_note: string | null;
  completed_at: number | null;
  schedule_delay_ms: number | null;
  queue_delay_ms: number | null;
  execution_ms: number | null;
  concurrent_count: number | null;
  duplicate_count: number;
  precheck_command: string | null;
  precheck_timeout_ms: number | null;
  precheck_bypassed: number;
  precheck_status: AutomationPrecheckStatus;
  precheck_started_at: number | null;
  precheck_completed_at: number | null;
  precheck_duration_ms: number | null;
  precheck_exit_code: number | null;
  precheck_stdout_tail: string | null;
  precheck_stderr_tail: string | null;
  precheck_error_message: string | null;
  trigger_source: 'watch' | null;
  source_event_id: number | null;
  source_kind: string | null;
  source_id: string | null;
  source_event_type: string | null;
  source_fingerprint: string | null;
  source_payload_json: string | null;
  action_kind: AutomationWatchActionKind;
  target_lane_id: string | null;
  updated_at: number;
}

interface AutomationRow {
  id: string;
  cron_expr: string | null;
  next_run_at: number | null;
  catch_up_policy: 'latest' | 'all' | 'skip';
  repo_path: string;
  repo_concurrency_limit: number;
  runtime: string;
  prompt: string;
  precheck_command: string | null;
  precheck_timeout_ms: number;
}

const AUTOMATION_QUEUE_ID = 'automation';
const AUTOMATION_BOOT_ID = process.env.O8_BOOT_ID?.trim()
  || `automation:${process.pid}:${randomUUID()}`;
const spine = new SqliteCloudJobStore();

function timeMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function statusFromSpine(row: AutomationFireRow, job: CloudJob): AutomationFireStatus {
  if (row.precheck_status === 'skipped') return 'skipped_precheck';
  if (row.precheck_status === 'error') return 'precheck_error';
  if (job.status === 'completed') return 'succeeded';
  if (job.status === 'parked' || job.status === 'cancelled' || job.status === 'leased') return job.status;
  if (row.status === 'recovered' || row.status === 'retrying') return row.status;
  return 'pending';
}

function fireFromRow(row: AutomationFireRow, knownJob?: CloudJob): AutomationFire {
  const job = knownJob ?? spine.get(AUTOMATION_QUEUE_ID, row.execution_job_id);
  if (!job) throw new Error(`Automation fire ${row.id} lost its durable execution job.`);
  return {
    id: row.id,
    automationId: row.automation_id,
    executionJobId: row.execution_job_id,
    source: row.trigger_source === 'watch' ? 'watch' : row.source,
    slotMs: row.slot_ms,
    idempotencyKey: row.idempotency_key,
    repoPath: row.repo_path,
    repoConcurrencyLimit: row.repo_concurrency_limit,
    status: statusFromSpine(row, job),
    scheduledAt: row.scheduled_at,
    persistedAt: row.persisted_at,
    claimedAt: timeMs(job.claimedAt),
    claimedBy: job.claimedBy ?? null,
    leaseToken: job.leaseToken ?? null,
    leaseExpiresAt: timeMs(job.leaseExpiresAt),
    claimCount: job.claimCount,
    attemptCount: job.executionAttempts + (job.status === 'completed' ? 1 : 0),
    recoveryCount: job.leaseRecoveryCount,
    maxAttempts: job.maxAttempts,
    nextAttemptAt: job.executionAttempts > 0 ? timeMs(job.availableAt) : null,
    laneId: row.lane_id,
    missionId: row.mission_id,
    resultNote: row.result_note ?? job.lastError ?? null,
    completedAt: row.completed_at ?? timeMs(job.completedAt),
    scheduleDelayMs: row.schedule_delay_ms,
    queueDelayMs: row.queue_delay_ms,
    executionMs: row.execution_ms,
    concurrentCount: row.concurrent_count ?? job.concurrentCount ?? null,
    duplicateCount: row.duplicate_count,
    precheckCommand: row.precheck_command,
    precheckTimeoutMs: row.precheck_timeout_ms,
    precheckBypassed: Boolean(row.precheck_bypassed),
    precheckStatus: row.precheck_status,
    precheckStartedAt: row.precheck_started_at,
    precheckCompletedAt: row.precheck_completed_at,
    precheckDurationMs: row.precheck_duration_ms,
    precheckExitCode: row.precheck_exit_code,
    precheckStdoutTail: row.precheck_stdout_tail,
    precheckStderrTail: row.precheck_stderr_tail,
    precheckErrorMessage: row.precheck_error_message,
    sourceEventId: row.source_event_id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    sourceEventType: row.source_event_type,
    sourceFingerprint: row.source_fingerprint,
    sourcePayload: row.source_payload_json ? (() => {
      try {
        const parsed = JSON.parse(row.source_payload_json) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : null;
      } catch {
        return null;
      }
    })() : null,
    actionKind: row.action_kind,
    targetLaneId: row.target_lane_id,
    updatedAt: row.updated_at,
  };
}

function scheduledIdentity(automationId: string, slotMs: number): string {
  return createHash('sha256').update(`${automationId}:${slotMs}`).digest('hex').slice(0, 24);
}

function insertFire(input: {
  automationId: string;
  source: Exclude<AutomationFireSource, 'watch'>;
  slotMs: number | null;
  idempotencyKey: string;
  repoPath: string;
  repoConcurrencyLimit: number;
  runtime: string;
  prompt: string;
  precheckCommand: string | null;
  precheckTimeoutMs: number;
  precheckBypassed?: boolean;
  triggerSource?: 'watch' | null;
  sourceEvent?: AutomationSourceEvent;
  actionKind?: AutomationWatchActionKind;
  targetLaneId?: string | null;
  scheduledAt: number;
  nowMs: number;
}): AutomationFire {
  const sqlite = getSqlite();
  const existing = sqlite.prepare('SELECT * FROM automation_fires WHERE idempotency_key = ?')
    .get(input.idempotencyKey) as AutomationFireRow | undefined;
  if (existing) {
    sqlite.prepare(`
      UPDATE automation_fires SET duplicate_count = duplicate_count + 1, updated_at = ? WHERE id = ?
    `).run(input.nowMs, existing.id);
    return fireFromRow(sqlite.prepare('SELECT * FROM automation_fires WHERE id = ?').get(existing.id) as AutomationFireRow);
  }

  const id = `fire_${input.source === 'scheduled'
    ? scheduledIdentity(input.automationId, input.slotMs ?? input.scheduledAt)
    : randomUUID()}`;
  const executionJobId = `automation:${id}`;
  const job = spine.enqueue({
    id: executionJobId,
    teamId: AUTOMATION_QUEUE_ID,
    idempotencyKey: input.idempotencyKey,
    sessionId: executionJobId,
    launch: {
      cwd: input.repoPath,
      prompt: input.prompt,
      model: input.runtime,
      clientMutationId: input.idempotencyKey,
    },
    maxAttempts: 3,
    availableAtMs: input.nowMs,
    concurrencyKey: input.repoPath,
    concurrencyLimit: input.repoConcurrencyLimit,
    nowMs: input.nowMs,
  });
  sqlite.prepare(`
    INSERT INTO automation_fires (
      id, automation_id, execution_job_id, source, slot_ms, idempotency_key,
      repo_path, repo_concurrency_limit, status, scheduled_at, persisted_at,
      schedule_delay_ms, precheck_command, precheck_timeout_ms, precheck_bypassed,
      precheck_status, trigger_source, source_event_id, source_kind, source_id,
      source_event_type, source_fingerprint, source_payload_json, action_kind,
      target_lane_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.automationId,
    executionJobId,
    input.source,
    input.slotMs,
    input.idempotencyKey,
    input.repoPath,
    Math.max(1, Math.floor(input.repoConcurrencyLimit)),
    input.scheduledAt,
    input.nowMs,
    Math.max(0, input.nowMs - input.scheduledAt),
    input.precheckCommand,
    input.precheckCommand ? input.precheckTimeoutMs : null,
    input.precheckBypassed ? 1 : 0,
    input.precheckBypassed ? 'bypassed' : input.precheckCommand ? 'pending' : 'none',
    input.triggerSource ?? null,
    input.sourceEvent?.sequence ?? null,
    input.sourceEvent?.sourceKind ?? null,
    input.sourceEvent?.sourceId ?? null,
    input.sourceEvent?.eventType ?? null,
    input.sourceEvent?.fingerprint ?? null,
    input.sourceEvent ? JSON.stringify(input.sourceEvent.payload) : null,
    input.actionKind ?? 'dispatch',
    input.targetLaneId ?? null,
    input.nowMs,
  );
  return fireFromRow(sqlite.prepare('SELECT * FROM automation_fires WHERE id = ?').get(id) as AutomationFireRow, job);
}

function dueSlots(row: AutomationRow, nowMs: number, maxAllSlots: number): {
  slots: number[];
  nextRunAt: number | null;
} {
  if (!row.cron_expr || row.next_run_at == null || row.next_run_at > nowMs) {
    return { slots: [], nextRunAt: row.next_run_at };
  }
  if (row.catch_up_policy === 'skip') {
    return { slots: [], nextRunAt: computeNextRunAt(row.cron_expr, nowMs) };
  }
  if (row.catch_up_policy === 'latest') {
    const latest = computePreviousRunAt(row.cron_expr, nowMs);
    return {
      slots: latest != null && latest >= row.next_run_at ? [latest] : [row.next_run_at],
      nextRunAt: computeNextRunAt(row.cron_expr, nowMs),
    };
  }

  const slots: number[] = [];
  let cursor: number | null = row.next_run_at;
  while (cursor != null && cursor <= nowMs && slots.length < maxAllSlots) {
    slots.push(cursor);
    cursor = computeNextRunAt(row.cron_expr, cursor);
  }
  return { slots, nextRunAt: cursor };
}

export function materializeDueAutomationFires(
  nowMs: number = Date.now(),
  maxAllSlots: number = 100,
): AutomationFire[] {
  const sqlite = getSqlite();
  const materialize = sqlite.transaction(() => {
    const rows = sqlite.prepare(`
      SELECT id, cron_expr, next_run_at, catch_up_policy, repo_path,
             repo_concurrency_limit, runtime, prompt, precheck_command, precheck_timeout_ms
      FROM automations
      WHERE enabled = 1 AND trigger_kind = 'cron' AND next_run_at <= ?
      ORDER BY next_run_at ASC
    `).all(nowMs) as AutomationRow[];
    const fires: AutomationFire[] = [];
    for (const row of rows) {
      const due = dueSlots(row, nowMs, Math.max(1, maxAllSlots));
      for (const slotMs of due.slots) {
        fires.push(insertFire({
          automationId: row.id,
          source: 'scheduled',
          slotMs,
          idempotencyKey: `automation-slot:${row.id}:${slotMs}`,
          repoPath: row.repo_path,
          repoConcurrencyLimit: row.repo_concurrency_limit,
          runtime: row.runtime,
          prompt: row.prompt,
          precheckCommand: row.precheck_command,
          precheckTimeoutMs: row.precheck_timeout_ms,
          scheduledAt: slotMs,
          nowMs,
        }));
      }
      sqlite.prepare('UPDATE automations SET next_run_at = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(due.nextRunAt, row.id);
    }
    return fires;
  });
  return materialize.immediate();
}

export function persistManualAutomationFire(
  automationId: string,
  idempotencyKey: string,
  nowMs: number = Date.now(),
  options: { bypassPrecheck?: boolean } = {},
): AutomationFire | undefined {
  const sqlite = getSqlite();
  const persist = sqlite.transaction(() => {
    const row = sqlite.prepare(`
      SELECT id, repo_path, repo_concurrency_limit, runtime, prompt,
             precheck_command, precheck_timeout_ms
      FROM automations WHERE id = ? AND enabled = 1
    `).get(automationId) as Pick<
      AutomationRow,
      'id' | 'repo_path' | 'repo_concurrency_limit' | 'runtime' | 'prompt' | 'precheck_command' | 'precheck_timeout_ms'
    > | undefined;
    if (!row) return undefined;
    return insertFire({
      automationId,
      source: 'manual',
      slotMs: null,
      idempotencyKey: `automation-manual:${automationId}:${idempotencyKey}`,
      repoPath: row.repo_path,
      repoConcurrencyLimit: row.repo_concurrency_limit,
      runtime: row.runtime,
      prompt: row.prompt,
      precheckCommand: row.precheck_command,
      precheckTimeoutMs: row.precheck_timeout_ms,
      precheckBypassed: options.bypassPrecheck,
      scheduledAt: nowMs,
      nowMs,
    });
  });
  return persist.immediate();
}

export function persistWatchAutomationFire(
  automationId: string,
  sourceEvent: AutomationSourceEvent,
  nowMs: number = Date.now(),
): AutomationFire | undefined {
  const sqlite = getSqlite();
  const persist = sqlite.transaction(() => {
    const row = sqlite.prepare(`
      SELECT id, repo_path, repo_concurrency_limit, runtime, prompt,
             precheck_command, precheck_timeout_ms, watch_action_kind, watch_target_lane_id
      FROM automations
      WHERE id = ? AND enabled = 1 AND trigger_kind = 'watch'
    `).get(automationId) as {
      id: string;
      repo_path: string;
      repo_concurrency_limit: number;
      runtime: string;
      prompt: string;
      precheck_command: string | null;
      precheck_timeout_ms: number;
      watch_action_kind: AutomationWatchActionKind;
      watch_target_lane_id: string | null;
    } | undefined;
    if (!row) return undefined;
    return insertFire({
      automationId,
      source: 'manual',
      triggerSource: 'watch',
      slotMs: null,
      idempotencyKey: `automation-watch:${automationId}:${sourceEvent.fingerprint}`,
      repoPath: row.repo_path,
      repoConcurrencyLimit: row.repo_concurrency_limit,
      runtime: row.runtime,
      prompt: row.prompt,
      precheckCommand: row.precheck_command,
      precheckTimeoutMs: row.precheck_timeout_ms,
      sourceEvent,
      actionKind: row.watch_action_kind,
      targetLaneId: row.watch_target_lane_id,
      scheduledAt: sourceEvent.occurredAt,
      nowMs,
    });
  });
  return persist.immediate();
}

export function recoverExpiredAutomationFires(nowMs: number = Date.now()): number {
  const recovered = spine.recoverExpiredLeases(AUTOMATION_QUEUE_ID, nowMs);
  if (recovered > 0) {
    getSqlite().prepare(`
      UPDATE automation_fires SET status = 'recovered', updated_at = ?
      WHERE execution_job_id IN (
        SELECT id FROM cloud_jobs
        WHERE team_id = ? AND status = 'pending' AND lease_recovery_count > 0
      ) AND status = 'leased'
    `).run(nowMs, AUTOMATION_QUEUE_ID);
  }
  return recovered;
}

export function claimNextAutomationFire(input: {
  workerId: string;
  leaseMs: number;
  concurrencyCap: number;
  fireId?: string;
  nowMs?: number;
}): AutomationFire | null {
  const nowMs = input.nowMs ?? Date.now();
  const requested = input.fireId ? getAutomationFire(input.fireId) : undefined;
  if (input.fireId && !requested) return null;
  const job = spine.claimNext({
    teamId: AUTOMATION_QUEUE_ID,
    cursor: 0,
    workerId: input.workerId,
    bootId: AUTOMATION_BOOT_ID,
    leaseMs: input.leaseMs,
    nowMs,
    jobId: requested?.executionJobId,
    maxConcurrent: input.concurrencyCap,
  });
  if (!job) return null;
  const enqueuedAt = timeMs(job.enqueuedAt) ?? nowMs;
  getSqlite().prepare(`
    UPDATE automation_fires
    SET status = 'leased', queue_delay_ms = ?, concurrent_count = ?, updated_at = ?
    WHERE execution_job_id = ?
  `).run(
    Math.max(0, (timeMs(job.claimedAt) ?? nowMs) - enqueuedAt),
    job.concurrentCount ?? 1,
    nowMs,
    job.id,
  );
  const row = getSqlite().prepare('SELECT * FROM automation_fires WHERE execution_job_id = ?')
    .get(job.id) as AutomationFireRow;
  return fireFromRow(row, job);
}

export function beginAutomationPrecheck(
  fireId: string,
  nowMs: number = Date.now(),
): AutomationFire | undefined {
  getSqlite().prepare(`
    UPDATE automation_fires
    SET precheck_status = 'running', precheck_started_at = ?, updated_at = ?
    WHERE id = ? AND precheck_status = 'pending'
  `).run(nowMs, nowMs, fireId);
  return getAutomationFire(fireId);
}

export function recordAutomationPrecheckResult(input: {
  fireId: string;
  status: 'passed' | 'skipped' | 'error';
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  errorMessage?: string | null;
  nowMs?: number;
}): AutomationFire | undefined {
  const nowMs = input.nowMs ?? Date.now();
  getSqlite().prepare(`
    UPDATE automation_fires
    SET precheck_status = ?, precheck_completed_at = ?,
        precheck_duration_ms = CASE
          WHEN precheck_started_at IS NULL THEN NULL
          ELSE MAX(0, ? - precheck_started_at)
        END,
        precheck_exit_code = ?, precheck_stdout_tail = ?, precheck_stderr_tail = ?,
        precheck_error_message = ?, updated_at = ?
    WHERE id = ? AND precheck_status = 'running'
  `).run(
    input.status,
    nowMs,
    nowMs,
    input.exitCode,
    input.stdoutTail || null,
    input.stderrTail || null,
    input.errorMessage ?? null,
    nowMs,
    input.fireId,
  );
  return getAutomationFire(input.fireId);
}

export function settleAutomationFire(input: {
  fireId: string;
  workerId: string;
  leaseToken: string;
  ok: boolean;
  laneId?: string;
  missionId?: string;
  note?: string;
  nowMs?: number;
  retryDelayMs?: number;
  terminalOnFailure?: boolean;
}): AutomationFire | undefined {
  const row = getSqlite().prepare('SELECT * FROM automation_fires WHERE id = ?')
    .get(input.fireId) as AutomationFireRow | undefined;
  if (!row) return undefined;
  const nowMs = input.nowMs ?? Date.now();
  const result = spine.appendEvent({
    teamId: AUTOMATION_QUEUE_ID,
    jobId: row.execution_job_id,
    workerId: input.workerId,
    leaseToken: input.leaseToken,
    type: input.ok ? 'completed' : 'errored',
    payload: { message: input.note, laneId: input.laneId, missionId: input.missionId },
    leaseMs: 60 * 60 * 1000,
    nowMs,
    retryDelayMs: input.retryDelayMs ?? 30_000,
    terminalOnFailure: input.terminalOnFailure ?? Boolean(input.laneId),
  });
  if (!result.accepted) return undefined;
  const status: AutomationFireStatus = result.job.status === 'completed'
    ? 'succeeded'
    : result.job.status === 'parked' ? 'parked' : 'retrying';
  const claimedAt = timeMs(result.job.claimedAt);
  getSqlite().prepare(`
    UPDATE automation_fires
    SET status = ?, lane_id = COALESCE(?, lane_id), mission_id = COALESCE(?, mission_id),
        result_note = ?, completed_at = ?, execution_ms = ?, updated_at = ?
    WHERE id = ?
  `).run(
    status,
    input.laneId ?? null,
    input.missionId ?? null,
    input.note ?? (input.ok ? 'Automation dispatched.' : 'Automation dispatch failed.'),
    status === 'retrying' ? null : nowMs,
    claimedAt == null ? null : Math.max(0, nowMs - claimedAt),
    nowMs,
    row.id,
  );
  return getAutomationFire(row.id);
}

export function getAutomationFire(fireId: string): AutomationFire | undefined {
  const row = getSqlite().prepare('SELECT * FROM automation_fires WHERE id = ?')
    .get(fireId) as AutomationFireRow | undefined;
  return row ? fireFromRow(row) : undefined;
}

export function cancelAutomationFires(
  automationId: string,
  note: string = 'Automation disabled by the operator.',
  nowMs: number = Date.now(),
): number {
  const sqlite = getSqlite();
  const cancel = sqlite.transaction(() => {
    const rows = sqlite.prepare(`
      SELECT fire.* FROM automation_fires fire
      JOIN cloud_jobs job ON job.id = fire.execution_job_id
      WHERE fire.automation_id = ? AND job.team_id = ? AND job.status = 'pending'
    `).all(automationId, AUTOMATION_QUEUE_ID) as AutomationFireRow[];
    for (const row of rows) {
      spine.cancel(AUTOMATION_QUEUE_ID, row.execution_job_id, nowMs);
      sqlite.prepare(`
        UPDATE automation_fires
        SET status = 'cancelled', result_note = ?, completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(note, nowMs, nowMs, row.id);
    }
    return rows.length;
  });
  return cancel.immediate();
}

export function listAutomationFires(automationId: string, limit: number = 20): AutomationFire[] {
  const rows = getSqlite().prepare(`
    SELECT * FROM automation_fires
    WHERE automation_id = ? ORDER BY scheduled_at DESC, persisted_at DESC LIMIT ?
  `).all(automationId, Math.min(Math.max(1, Math.floor(limit)), 500)) as AutomationFireRow[];
  return rows.map((row) => fireFromRow(row));
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

export function getAutomationFireMetrics(automationId: string): AutomationFireMetrics {
  const fires = listAutomationFires(automationId, 500);
  const values = (field: 'scheduleDelayMs' | 'queueDelayMs' | 'executionMs') => (
    fires.map((fire) => fire[field]).filter((value): value is number => value != null)
  );
  const metric = (field: 'scheduleDelayMs' | 'queueDelayMs' | 'executionMs') => ({
    p50: percentile(values(field), 0.5),
    p95: percentile(values(field), 0.95),
  });
  return {
    count: fires.length,
    scheduleDelayMs: metric('scheduleDelayMs'),
    queueDelayMs: metric('queueDelayMs'),
    executionMs: metric('executionMs'),
    maxConcurrentFires: Math.max(0, ...fires.map((fire) => fire.concurrentCount ?? 0)),
    duplicateFireCount: fires.reduce((total, fire) => total + fire.duplicateCount, 0),
  };
}
