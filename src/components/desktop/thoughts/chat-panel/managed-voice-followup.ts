import type { ComposerQueuePayload, QueuedComposerSendRecord } from '@/lib/orchestrator/composer-queue-types';
import type { useDurableComposerQueue } from './useDurableComposerQueue';

export interface ManagedVoiceFollowup {
  ready: boolean;
  items: QueuedComposerSendRecord[];
  enqueue: (id: string, text: string, afterTaskId: string) => Promise<string>;
  cancel: () => Promise<string>;
}

export function voiceFollowupReceipt(item: QueuedComposerSendRecord): string {
  if (item.status === 'applied') return 'The backend already accepted this follow-up. I did not submit it again. Acceptance does not confirm completion or that the instruction was applied.';
  if (item.admittedAt !== null) return 'This follow-up may already have reached the backend. I did not submit it again. Inspect its result in this conversation before retrying.';
  if (item.status === 'held') return 'This follow-up is held for review. I did not submit a new request. Inspect the queue in this conversation.';
  if (item.status === 'dispatching') return 'This follow-up is being prepared for the backend. I did not submit a duplicate. Acceptance is not yet confirmed.';
  if (item.status === 'cancelled') return 'This follow-up was removed from the queue. I did not submit a new request.';
  return 'The follow-up was saved for the exact task to finish. Saving it does not confirm backend acceptance or completion. Say cancel queued to remove any pending follow-up.';
}

export function voiceFollowupRemovalReceipt(): string {
  return 'I removed the saved voice follow-up from the queue. This does not stop or undo work already submitted, or confirm its outcome.';
}

/** Voice uses the same persisted queue and its normal composer disclosure. */
export function managedVoiceFollowup(
  queue: ReturnType<typeof useDurableComposerQueue>, capture: (text: string) => ComposerQueuePayload,
): ManagedVoiceFollowup {
  const items = queue.items.filter(item => item.payload.afterTaskId);
  return {
    ready: queue.ready && !queue.error, items,
    enqueue: async (id, text, afterTaskId) => {
      if (!queue.ready || queue.error) throw new Error('Queued messages are not loaded. Check the conversation before retrying.');
      const payload = capture(text);
      if (payload.routing.collide) throw new Error('Voice follow-ups require one selected orchestrator runtime.');
      const item = await queue.enqueueVoice({ ...payload, afterTaskId, routing: { ...payload.routing, pinBackend: true } }, id);
      return voiceFollowupReceipt(item);
    },
    cancel: queue.cancelVoiceFollowups,
  };
}
