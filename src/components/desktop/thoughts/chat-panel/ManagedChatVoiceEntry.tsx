import type { ComponentProps } from 'react';
import { ManagedLiveButton } from './ManagedLiveButton';
import { managedVoiceFollowup } from './managed-voice-followup';
import type { useDurableComposerQueue } from './useDurableComposerQueue';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';

type Props = Omit<ComponentProps<typeof ManagedLiveButton>, 'binding' | 'followup'> & {
  identity: unknown[];
  queue: ReturnType<typeof useDurableComposerQueue>;
  capture: (text: string) => ComposerQueuePayload;
};

/** A changed chat or routing identity closes the previous pinned voice session. */
export function ManagedChatVoiceEntry({ identity, queue, capture, ...props }: Props) {
  const binding = JSON.stringify(identity);
  return <ManagedLiveButton {...props} key={binding} binding={binding} followup={managedVoiceFollowup(queue, capture)} />;
}
