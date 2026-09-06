import { randomUUID } from 'node:crypto';

import { getSqlite } from '@/lib/db';
import { finalizeOrchestratorReviewTurn, type ReviewTurnOutcome } from '@/lib/approvals/store';
import { recordLaneEvent } from '@/lib/lane/events';

interface ReviewTurnEventPayload {
  reviewTurnId?: unknown;
  threadId?: unknown;
  backend?: unknown;
  surface?: unknown;
  expectedHeadSha?: unknown;
}

interface ReviewAttemptStatusRow {
  status: string;
}

export interface ActiveReviewTurn {
  id: string;
  threadId: string | null;
  backend: string | null;
  surface: string | null;
  expectedHeadSha: string | null;
}

export interface ReviewTurnStopResult extends ActiveReviewTurn {
  abortRequested: boolean;
}

const reviewTurnAbortControllers = new Map<string, {
  laneId: string;
  controller: AbortController;
}>();

export function startReviewTurn(input: {
  laneId: string;
  threadId: string;
  backend: string;
  surface: string;
  expectedHeadSha?: string | null;
}): string {
  const reviewTurnId = `review-turn-${randomUUID()}`;
  recordLaneEvent(input.laneId, 'review_turn_started', 'system', {
    reviewTurnId,
    threadId: input.threadId,
    backend: input.backend,
    surface: input.surface,
    expectedHeadSha: input.expectedHeadSha ?? null,
  });
  return reviewTurnId;
}

function findUnsettledReviewTurn(laneId: string): ActiveReviewTurn | null {
  const row = getSqlite().prepare(`
    SELECT verb, payload_json
    FROM lane_events
    WHERE lane_id = ?
      AND verb IN ('review_turn_started', 'review_turn_finished', 'review_turn_stopped')
    ORDER BY rowid DESC
    LIMIT 1
  `).get(laneId) as { verb: string; payload_json: string } | undefined;
  if (!row || row.verb !== 'review_turn_started') return null;
  try {
    const payload = JSON.parse(row.payload_json) as ReviewTurnEventPayload;
    return typeof payload.reviewTurnId === 'string'
      ? {
          id: payload.reviewTurnId,
          threadId: typeof payload.threadId === 'string' ? payload.threadId : null,
          backend: typeof payload.backend === 'string' ? payload.backend : null,
          surface: typeof payload.surface === 'string' ? payload.surface : null,
          expectedHeadSha: typeof payload.expectedHeadSha === 'string'
            ? payload.expectedHeadSha
            : null,
        }
      : null;
  } catch {
    return null;
  }
}

function reviewAttemptStatus(
  laneId: string,
  active: ActiveReviewTurn,
): string | null {
  if (active.surface !== 'auto-review' || !active.threadId) return null;
  const prefix = `auto-review-${laneId}-`;
  if (!active.threadId.startsWith(prefix)) return null;
  const reviewId = active.threadId
    .slice(prefix.length)
    .replace(/-verdict-retry$/, '');
  if (!reviewId) return null;
  try {
    const row = getSqlite().prepare(
      'SELECT status FROM review_queue WHERE id = ? AND lane_id = ? LIMIT 1',
    ).get(reviewId, laneId) as ReviewAttemptStatusRow | undefined;
    return row?.status ?? null;
  } catch {
    return null;
  }
}

export function findActiveReviewTurn(laneId: string): ActiveReviewTurn | null {
  const active = findUnsettledReviewTurn(laneId);
  if (!active) return null;
  const attemptStatus = reviewAttemptStatus(laneId, active);
  return attemptStatus && attemptStatus !== 'in_progress' ? null : active;
}

export function findActiveReviewTurnId(laneId: string): string | null {
  return findActiveReviewTurn(laneId)?.id ?? null;
}

export function bindReviewTurnAbortController(
  laneId: string,
  reviewTurnId: string,
  controller: AbortController,
): () => void {
  reviewTurnAbortControllers.set(reviewTurnId, { laneId, controller });
  return () => {
    const binding = reviewTurnAbortControllers.get(reviewTurnId);
    if (binding?.laneId === laneId && binding.controller === controller) {
      reviewTurnAbortControllers.delete(reviewTurnId);
    }
  };
}

export function stopActiveReviewTurn(input: {
  laneId: string;
  reason: 'abandoned' | 'packet_discarded' | 'packet_stopped' | 'superseded';
}): ReviewTurnStopResult | null {
  const abortedTurnIds = new Set<string>();
  for (const [reviewTurnId, binding] of reviewTurnAbortControllers) {
    if (binding.laneId !== input.laneId) continue;
    binding.controller.abort(input.reason);
    reviewTurnAbortControllers.delete(reviewTurnId);
    abortedTurnIds.add(reviewTurnId);
  }
  const active = findUnsettledReviewTurn(input.laneId);
  if (!active) return null;
  const abortRequested = abortedTurnIds.has(active.id);
  recordLaneEvent(input.laneId, 'review_turn_stopped', 'system', {
    reviewTurnId: active.id,
    threadId: active.threadId,
    backend: active.backend,
    surface: active.surface,
    sessionClass: 'review',
    reason: input.reason,
    abortRequested,
  });
  return { ...active, abortRequested };
}

export function finishReviewTurn(input: {
  laneId: string;
  reviewTurnId: string;
  outcome: ReviewTurnOutcome;
}): number {
  recordLaneEvent(input.laneId, 'review_turn_finished', 'system', {
    reviewTurnId: input.reviewTurnId,
    outcome: input.outcome,
  });
  return finalizeOrchestratorReviewTurn(input.reviewTurnId, input.outcome);
}
