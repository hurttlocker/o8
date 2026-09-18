/**
 * Review-ready self-continuation (#1481), moved out of the ws-server so the
 * real path is reachable from tests (#2467). Behaviour is unchanged; the one
 * addition is the record-only wake triage started before the enqueue.
 */
import { resolveReviewContinuationSync } from '@/lib/operator/defaults';
import { startWakeTriage } from '@/lib/orchestrator/wake-triage';

export interface ReviewContinuationLane { id: string; label: string; repoPath: string; packetId?: string | null; branch?: string | null }

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
): void {
  if (!lane.packetId) return; // ad-hoc lanes have no mission contract to continue
  if (!resolveReviewContinuationSync()) return;
  const last = reviewContinuationQueuedAt.get(lane.id);
  const now = Date.now();
  if (last && now - last < REVIEW_CONTINUATION_DEDUPE_MS) return;
  reviewContinuationQueuedAt.set(lane.id, now);
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
