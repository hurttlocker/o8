import type { ComposerQueuePayload, QueuedComposerSendRecord } from '@/lib/orchestrator/composer-queue-types';
import type { useDurableComposerQueue } from './useDurableComposerQueue';

export interface ManagedVoiceFollowup {
  ready: boolean;
  items: QueuedComposerSendRecord[];
  enqueue: (id: string, text: string, afterTaskId: string) => Promise<void>;
  cancel: () => Promise<string>;
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
      await queue.enqueue({ ...payload, afterTaskId, routing: { ...payload.routing, pinBackend: true } }, id);
    },
    cancel: queue.cancelVoiceFollowups,
  };
}
