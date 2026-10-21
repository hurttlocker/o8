/** Review-ready routing returns a review to the chat that owns the mission, or stops at review. */
import { appendEvent } from '@/lib/lane/registry';
import { manualReviewRequested } from '@/lib/lane/review-mode';
import { resolveReviewContinuationSync } from '@/lib/operator/defaults';
import { resolveReviewChatOrigin, type ReviewChatOrigin } from '@/lib/orchestrator/review-continuation-origin';
import { startWakeTriage } from '@/lib/orchestrator/wake-triage';

export interface ReviewContinuationLane { id: string; label: string; repoPath: string; packetId?: string | null; branch?: string | null }

export function routeReviewContinuation(
  lane: ReviewContinuationLane,
  enqueuePersistentLead: (lane: ReviewContinuationLane & { packetId: string }) => boolean,
  enqueueOrigin?: (lane: ReviewContinuationLane, origin: ReviewChatOrigin) => void,
): void {
  if (manualReviewRequested()) return;
  if (lane.packetId && enqueuePersistentLead({ ...lane, packetId: lane.packetId })) return;
  if (!lane.packetId) return;
  const resolution = resolveReviewChatOrigin(lane);
  if (resolution.kind === 'refused') {
    console.warn(`[review-continuation] Refused: ${resolution.reason}`);
    return;
  }
  if (resolution.kind === 'bound') {
    enqueueOrigin?.(lane, resolution.origin);
    return;
  }
  // #3727: no recorded chat origin (a turn sent without a thread, or a mission
  // created over MCP or the CLI). The repository's default session did not
  // create this mission and cannot see its instructions, so it must not be woken
  // to review and merge it. The lane stays at review for its owner.
  if (resolveReviewContinuationSync()) {
    console.warn(`[review-continuation] Lane ${lane.id} has no chat origin; left at review.`);
    // The record is for visibility only; a lane removed meanwhile must not break routing.
    try {
      appendEvent(lane.id, 'update', 'system', { event: 'review_continuation_unbound', packetId: lane.packetId });
    } catch { /* lane row gone */ }
  }
}

// #1481 — review-ready self-continuation. When a MISSION lane lands at
// review, the fleet must not park until the operator re-prompts: queue one
// bounded orchestrator turn ("review + merge per the standing instruction").
// Gated on its own operator setting (reviewContinuation, default ON —
// distinct from the noisy supervisor failure-investigation escalations), scoped to
// packet-bound lanes, and deduped per lane so a flapping transition can't
// spam turns. The operator prompt arms the loop; it is not its clock.
const REVIEW_CONTINUATION_DEDUPE_MS = 10 * 60 * 1000;
const reviewContinuationQueuedAt = new Map<string, number>();

export function queueReviewContinuation(
  lane: ReviewContinuationLane,
  enqueue: (repoPath: string, message: string, label: string) => void,
  dedupe: 'memory' | 'durable' = 'memory',
): void {
  if (manualReviewRequested()) return;
  if (!lane.packetId) return; // ad-hoc lanes have no mission contract to continue
  if (!resolveReviewContinuationSync()) return;
  const last = dedupe === 'memory' ? reviewContinuationQueuedAt.get(lane.id) : undefined;
  const now = Date.now();
  if (last && now - last < REVIEW_CONTINUATION_DEDUPE_MS) return;
  if (dedupe === 'memory') reviewContinuationQueuedAt.set(lane.id, now);
  if (reviewContinuationQueuedAt.size > 200) {
    for (const [key, ts] of reviewContinuationQueuedAt) {
      if (now - ts > REVIEW_CONTINUATION_DEDUPE_MS) reviewContinuationQueuedAt.delete(key);
    }
  }
  startWakeTriage({ source: 'review-continuation', laneId: lane.id });
  enqueue(
    lane.repoPath,
    [
      `[FLEET] Lane "${lane.label}" (${lane.id}, packet ${lane.packetId}) reached review-ready.`,
      'Per the mission\'s standing instruction, continue the loop for THIS packet now.',
      'This thread\'s own instructions come first: if the operator said not to merge, record the review with submit_review and do not call approve_and_merge.',
      `1. o8_packet_diff / o8_merge_preview for packet ${lane.packetId}`,
      '2. If the diff is clean and merging is allowed here, submit_review + approve_and_merge (rebase-before-merge discipline applies).',
      '3. If it is not clean, record findings via submit_review(approved:false) or steer the worker — do not merge.',
      'This is a bounded self-continuation turn (one per lane review transition; Settings → Dispatch & Supervision → Review continuation).',
    ].join('\n'),
    'review continuation',
  );
}
