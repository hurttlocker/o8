'use client';

import { useLayoutEffect, useMemo, useRef } from 'react';
import { CollapsiblePlanCard } from '@/components/desktop/CollapsiblePlanCard';
import type { ThoughtsChatPanelHandle } from './types';
import type { TaskArtifactDeliverInput } from './TaskArtifactCard';
import type { ComposerTranscriptQueue } from './ComposerQueuedMessages';

export function TranscriptPlan({ text, threadId }: { text: string; threadId: string | null }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
    <CollapsiblePlanCard key={`plan-${threadId ?? 'active'}`} text={text} />
  </div>;
}

/** Draft edits must not invalidate the transcript's event handlers. Read the
 * latest committed send state when an action is actually invoked. */
export function useTranscriptActions(actions: {
  sendNow: ThoughtsChatPanelHandle['sendNow'];
  retry: (id: string) => void;
  deliver: (action: TaskArtifactDeliverInput) => boolean;
  queue: ComposerTranscriptQueue;
}) {
  const current = useRef(actions);
  useLayoutEffect(() => { current.current = actions; });
  const callbacks = useMemo(() => ({
    selectTranscriptSuggestion: (chip: string) => { current.current.sendNow(chip); },
    retryTranscriptDelivery: (id: string) => { current.current.retry(id); },
    deliverTranscriptArtifact: (action: TaskArtifactDeliverInput) => current.current.deliver(action),
    onSteer: (id: string) => { current.current.queue.onSteer(id); },
    onCancel: (sequence: number) => { current.current.queue.onCancel(sequence); },
  }), []);
  const { items, canSteer, removing, promoting, steerableIds } = actions.queue;
  const composerQueue = useMemo(() => ({ items, canSteer, removing, promoting, steerableIds,
    onSteer: callbacks.onSteer, onCancel: callbacks.onCancel,
  }), [items, canSteer, removing, promoting, steerableIds, callbacks]);
  return { ...callbacks, composerQueue };
}
