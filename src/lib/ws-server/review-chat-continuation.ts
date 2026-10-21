import { randomUUID } from 'node:crypto';
import { appendEvent } from '@/lib/lane/registry';
import { claimReviewChatContinuation, resolveReviewChatOrigin, type ReviewChatOrigin } from '@/lib/orchestrator/review-continuation-origin';
import type { ReviewContinuationLane } from '@/lib/orchestrator/review-continuation';
import { runBoundChatContinuation, type BoundChatContinuationHooks } from './bound-chat-continuation';

export type ReviewChatContinuationHooks = BoundChatContinuationHooks;

/** Review and shared-worker returns use the same canonical chat execution path. */
export async function runReviewChatContinuation(
  lane: ReviewContinuationLane, expected: ReviewChatOrigin, message: string, hooks: ReviewChatContinuationHooks,
): Promise<void> {
  const check = () => {
    const current = resolveReviewChatOrigin(lane);
    if (current.kind !== 'bound' || JSON.stringify(current.origin) !== JSON.stringify(expected)) {
      appendEvent(lane.id, 'update', 'system', { event: 'chat_review_continuation_refused', reason: 'Origin changed while queued.' });
      throw new Error('Review origin changed while queued.');
    }
  };
  await runBoundChatContinuation({ repoPath: lane.repoPath, origin: expected, message,
    assistantMessageId: `assistant-review-${randomUUID()}`, check,
    legacyPermissionMode: 'full', claim: () => claimReviewChatContinuation(lane, expected) }, {
    ...hooks,
    registerAbort: (repoPath, origin, controller) => {
      const release = hooks.registerAbort(repoPath, origin, controller);
      return () => {
        try {
          if (controller.signal.aborted) appendEvent(lane.id, 'update', 'system', {
            event: 'chat_review_continuation_interrupted', threadId: expected.threadId,
          });
        } finally { release(); }
      };
    },
  });
}
