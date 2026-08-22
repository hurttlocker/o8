import { randomUUID } from 'node:crypto';

import { getSqlite } from '@/lib/db';
import { finalizeOrchestratorReviewTurn, type ReviewTurnOutcome } from '@/lib/approvals/store';
import { recordLaneEvent } from '@/lib/lane/events';

interface ReviewTurnEventPayload {
  reviewTurnId?: unknown;
  surface?: unknown;
}

export interface ActiveReviewTurn {
  id: string;
  surface: string | null;
}

export function startReviewTurn(input: {
  laneId: string;
  threadId: string;
  backend: string;
  surface: string;
}): string {
  const reviewTurnId = `review-turn-${randomUUID()}`;
  recordLaneEvent(input.laneId, 'review_turn_started', 'system', {
    reviewTurnId,
    threadId: input.threadId,
    backend: input.backend,
    surface: input.surface,
  });
  return reviewTurnId;
}

export function findActiveReviewTurn(laneId: string): ActiveReviewTurn | null {
  const row = getSqlite().prepare(`
    SELECT verb, payload_json
    FROM lane_events
    WHERE lane_id = ?
      AND verb IN ('review_turn_started', 'review_turn_finished')
    ORDER BY rowid DESC
    LIMIT 1
  `).get(laneId) as { verb: string; payload_json: string } | undefined;
  if (!row || row.verb !== 'review_turn_started') return null;
  try {
    const payload = JSON.parse(row.payload_json) as ReviewTurnEventPayload;
    return typeof payload.reviewTurnId === 'string'
      ? {
          id: payload.reviewTurnId,
          surface: typeof payload.surface === 'string' ? payload.surface : null,
        }
      : null;
  } catch {
    return null;
  }
}

export function findActiveReviewTurnId(laneId: string): string | null {
  return findActiveReviewTurn(laneId)?.id ?? null;
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
