/** Review-ready routing preserves a persisted chat origin before considering legacy defaults. */
import { resolveReviewContinuationSync } from '@/lib/operator/defaults';
import { resolveReviewChatOrigin, type ReviewChatOrigin } from '@/lib/orchestrator/review-continuation-origin';
import { startWakeTriage } from '@/lib/orchestrator/wake-triage';

export interface ReviewContinuationLane { id: string; label: string; repoPath: string; packetId?: string | null; branch?: string | null }

export function routeReviewContinuation(
  lane: ReviewContinuationLane,
  enqueue: (repoPath: string, message: string, label: string) => void,
  enqueuePersistentLead: (lane: ReviewContinuationLane & { packetId: string }) => boolean,
  enqueueOrigin?: (lane: ReviewContinuationLane, origin: ReviewChatOrigin) => void,
): void {
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
  queueReviewContinuation(lane, enqueue);
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
      'Per the mission\'s standing instruction, continue the loop for THIS packet now:',
      `1. o8_packet_diff / o8_merge_preview for packet ${lane.packetId}`,
      '2. If the diff is clean, submit_review + approve_and_merge (rebase-before-merge discipline applies).',
      '3. If it is not clean, record findings via submit_review(approved:false) or steer the worker — do not merge.',
      'This is a bounded self-continuation turn (one per lane review transition; Settings → Dispatch & Supervision → Review continuation).',
    ].join('\n'),
    'review continuation',
  );
}
