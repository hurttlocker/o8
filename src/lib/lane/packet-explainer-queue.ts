import { randomUUID } from 'node:crypto';

import { getSqlite } from '@/lib/db';
import { resolvePacketExplainerEnabledSync } from '@/lib/operator/defaults';
import { recordLaneEvent } from './events';
import { getLane } from './registry';
import {
  generatePacketExplainer,
  type GenerateExplainerParams,
  type PacketExplainerGenerationResult,
} from './packet-explainer';

const DRAIN_INTERVAL_MS = 5_000;
const MAX_EXPLAINER_ATTEMPTS = 3;

type StoredExplainerPayload = Omit<GenerateExplainerParams, 'lane' | 'signal'>;

interface QueuedExplainer {
  id: string;
  packet_id: string;
  lane_id: string;
  repo_path: string;
  payload_json: string;
  attempts: number;
  contention_count: number;
  created_at: string;
  claim_owner: string;
}

type ExplainerRunner = (
  params: GenerateExplainerParams,
) => Promise<PacketExplainerGenerationResult>;

let drainTimer: ReturnType<typeof setInterval> | null = null;
let activeExplainer: { row: QueuedExplainer; controller: AbortController } | null = null;

function hasCorrectnessReviewDemand(): boolean {
  return Boolean(getSqlite().prepare(
    "SELECT 1 FROM review_queue WHERE status IN ('pending', 'in_progress') LIMIT 1",
  ).get());
}

function millisecondsSince(value: string): number {
  const parsed = Date.parse(value.endsWith('Z') ? value : `${value}Z`);
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : 0;
}

async function stampPacket(
  packetId: string,
  explainer: NonNullable<import('@/lib/orchestrator/types').OrchestratorPacket['explainer']>,
): Promise<void> {
  try {
    const { patchMissionPacket } = await import('@/lib/orchestrator/operator-mission-service/packet-patch');
    await patchMissionPacket(packetId, { explainer });
  } catch (error) {
    console.warn(`[explainer-queue] Failed to stamp packet ${packetId}:`, error);
  }
}

function claimNextExplainer(): QueuedExplainer | null {
  if (hasCorrectnessReviewDemand()) return null;
  return getSqlite().transaction(() => {
    if (hasCorrectnessReviewDemand()) return null;
    const row = getSqlite().prepare(
      `SELECT id, packet_id, lane_id, repo_path, payload_json, attempts,
              contention_count, created_at
       FROM explainer_queue
       WHERE status = 'pending'
       ORDER BY updated_at ASC, created_at ASC LIMIT 1`,
    ).get() as Omit<QueuedExplainer, 'claim_owner'> | undefined;
    if (!row) return null;
    const claimOwner = `explainer-owner-${process.pid}-${randomUUID().slice(0, 8)}`;
    const claimed = getSqlite().prepare(
      `UPDATE explainer_queue
       SET status = 'in_progress', claimed_at = datetime('now'), claim_owner = ?,
           queue_wait_ms = ?, updated_at = datetime('now')
       WHERE id = ? AND status = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM review_queue WHERE status IN ('pending', 'in_progress')
         )`,
    ).run(claimOwner, millisecondsSince(row.created_at), row.id);
    return claimed.changes === 1 ? { ...row, claim_owner: claimOwner } : null;
  })();
}

function settleDeferred(
  row: QueuedExplainer,
  result: PacketExplainerGenerationResult,
): void {
  getSqlite().prepare(
    `UPDATE explainer_queue
     SET status = 'pending', contention_count = contention_count + 1,
         last_error = ?, backend = ?, turn_duration_ms = ?, approximate_cost = ?,
         outcome = 'deferred', claimed_at = NULL, claim_owner = NULL,
         updated_at = datetime('now')
     WHERE id = ? AND status = 'in_progress' AND claim_owner = ?`,
  ).run(
    result.reason ?? 'correctness review took priority',
    result.backend,
    result.durationMs,
    result.approximateCost,
    row.id,
    row.claim_owner,
  );
  recordLaneEvent(row.lane_id, 'explainer_deferred', 'system', {
    packetId: row.packet_id,
    explainerId: row.id,
    reason: result.reason ?? 'correctness review took priority',
    turnDurationMs: result.durationMs,
    backend: result.backend,
    approximateCost: result.approximateCost,
  });
}

async function settleFailed(
  row: QueuedExplainer,
  payload: StoredExplainerPayload,
  result: PacketExplainerGenerationResult,
): Promise<void> {
  const attempts = row.attempts + 1;
  const terminal = attempts >= MAX_EXPLAINER_ATTEMPTS;
  getSqlite().prepare(
    `UPDATE explainer_queue
     SET status = ?, attempts = ?, last_error = ?, backend = ?,
         turn_duration_ms = ?, approximate_cost = ?, outcome = ?,
         claimed_at = NULL, claim_owner = NULL,
         completed_at = CASE WHEN ? THEN datetime('now') ELSE NULL END,
         updated_at = datetime('now')
     WHERE id = ? AND status = 'in_progress' AND claim_owner = ?`,
  ).run(
    terminal ? 'failed' : 'pending',
    attempts,
    result.reason ?? 'explainer generation failed',
    result.backend,
    result.durationMs,
    result.approximateCost,
    terminal ? 'failed' : 'retrying',
    terminal ? 1 : 0,
    row.id,
    row.claim_owner,
  );
  recordLaneEvent(row.lane_id, terminal ? 'explainer_failed' : 'explainer_deferred', 'system', {
    packetId: row.packet_id,
    explainerId: row.id,
    attempts,
    reason: result.reason ?? 'explainer generation failed',
    turnDurationMs: result.durationMs,
    backend: result.backend,
    approximateCost: result.approximateCost,
  });
  if (terminal) {
    await stampPacket(row.packet_id, {
      status: 'failed',
      changedFileCount: payload.changedFileCount,
      generatedAt: new Date().toISOString(),
      error: (result.reason ?? 'explainer generation failed').slice(0, 300),
    });
  }
}

/** Enqueue only the optional artifact; this never mutates review attempts or lane status. */
export async function enqueuePacketExplainer(
  params: GenerateExplainerParams,
): Promise<string | null> {
  if (!resolvePacketExplainerEnabledSync()) return null;
  const payload: StoredExplainerPayload = {
    packetId: params.packetId,
    packetTitle: params.packetTitle,
    packetSummary: params.packetSummary,
    diffSummary: params.diffSummary,
    changedFileCount: params.changedFileCount,
    deviationsRaw: params.deviationsRaw,
    reviewContext: params.reviewContext,
  };
  const id = `explainer-${randomUUID().slice(0, 12)}`;
  getSqlite().transaction(() => {
    getSqlite().prepare(
      `UPDATE explainer_queue
       SET status = 'completed', outcome = 'superseded', completed_at = datetime('now'),
           updated_at = datetime('now')
       WHERE packet_id = ? AND status = 'pending'`,
    ).run(params.packetId);
    getSqlite().prepare(
      `INSERT INTO explainer_queue (
         id, packet_id, lane_id, repo_path, payload_json, status, attempts,
         contention_count, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, datetime('now'), datetime('now'))`,
    ).run(id, params.packetId, params.lane.id, params.lane.repoPath, JSON.stringify(payload));
  })();
  await stampPacket(params.packetId, {
    status: 'generating',
    changedFileCount: params.changedFileCount,
    generatedAt: null,
  });
  recordLaneEvent(params.lane.id, 'explainer_queued', 'system', {
    packetId: params.packetId,
    explainerId: id,
  });
  return id;
}

/** Correctness enqueue chokepoint: preempt the optional turn immediately. */
export function notifyCorrectnessReviewQueued(): void {
  activeExplainer?.controller.abort('correctness review queued');
}

/** One durable drain tick. Correctness demand is checked before and during claim. */
export async function drainPacketExplainerQueue(
  runner: ExplainerRunner = generatePacketExplainer,
): Promise<void> {
  if (activeExplainer || !resolvePacketExplainerEnabledSync()) return;
  const row = claimNextExplainer();
  if (!row) return;
  const lane = getLane(row.lane_id);
  let payload: StoredExplainerPayload;
  try {
    payload = JSON.parse(row.payload_json) as StoredExplainerPayload;
  } catch {
    payload = {
      packetId: row.packet_id,
      packetTitle: row.packet_id,
      packetSummary: '',
      diffSummary: '',
      changedFileCount: 0,
      deviationsRaw: null,
      reviewContext: '',
    };
  }
  if (!lane) {
    await settleFailed(row, payload, {
      outcome: 'failed', backend: null, durationMs: 0, approximateCost: null,
      reason: `lane ${row.lane_id} no longer exists`,
    });
    return;
  }

  const controller = new AbortController();
  activeExplainer = { row, controller };
  recordLaneEvent(row.lane_id, 'explainer_started', 'system', {
    packetId: row.packet_id,
    explainerId: row.id,
    queueWaitMs: millisecondsSince(row.created_at),
  });
  try {
    const result = await runner({ ...payload, lane, signal: controller.signal });
    if (result.outcome === 'ready') {
      getSqlite().prepare(
        `UPDATE explainer_queue
         SET status = 'completed', backend = ?, turn_duration_ms = ?,
             approximate_cost = ?, outcome = 'ready', claimed_at = NULL,
             claim_owner = NULL, completed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND status = 'in_progress' AND claim_owner = ?`,
      ).run(result.backend, result.durationMs, result.approximateCost, row.id, row.claim_owner);
      recordLaneEvent(row.lane_id, 'explainer_completed', 'system', {
        packetId: row.packet_id,
        explainerId: row.id,
        turnDurationMs: result.durationMs,
        backend: result.backend,
        approximateCost: result.approximateCost,
      });
    } else if (result.outcome === 'deferred' || controller.signal.aborted) {
      settleDeferred(row, {
        ...result,
        outcome: 'deferred',
        reason: result.reason ?? 'correctness review took priority',
      });
    } else {
      await settleFailed(row, payload, result);
    }
  } catch (error) {
    await settleFailed(row, payload, {
      outcome: 'failed',
      backend: null,
      durationMs: 0,
      approximateCost: null,
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (activeExplainer?.row.id === row.id) activeExplainer = null;
  }
}

export function startPacketExplainerQueueDrain(): () => void {
  if (drainTimer) return () => { /* already running */ };
  getSqlite().prepare(
    `UPDATE explainer_queue
     SET status = 'pending', last_error = 'Recovered after process restart',
         claimed_at = NULL, claim_owner = NULL, updated_at = datetime('now')
     WHERE status = 'in_progress'`,
  ).run();
  drainTimer = setInterval(() => {
    void drainPacketExplainerQueue().catch((error) => {
      console.error('[explainer-queue] Drain error:', error);
    });
  }, DRAIN_INTERVAL_MS);
  void drainPacketExplainerQueue().catch(() => {});
  return () => {
    if (drainTimer) clearInterval(drainTimer);
    drainTimer = null;
    activeExplainer?.controller.abort('explainer drain stopped');
  };
}
