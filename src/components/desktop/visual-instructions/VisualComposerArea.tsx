'use client';

import { forwardRef, useCallback, useRef } from 'react';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { ComposerArea, type ComposerAreaProps } from '@/components/desktop/thoughts/chat-panel/ComposerArea';
import { VisualInstructionComposer, type VisualInstructionComposerProps } from './VisualInstructionComposer';
import { VisualInstructionAttachments, VisualInstructionEntry, VisualInstructionFeedback, VisualInstructionFooter } from './VisualInstructionDraftView';

type Props = ComposerAreaProps & { visual: Omit<VisualInstructionComposerProps, 'anchor' | 'children'> };
/** Both plain text and marked images use the same input, keyboard path, and composer geometry. */
export const VisualComposerArea = forwardRef<HTMLTextAreaElement, Props>(function VisualComposerArea({ visual, ...props }, ref) {
  const anchor = useRef<HTMLTextAreaElement | null>(null);
  const auth = useO8Auth();
  const setAnchor = useCallback((node: HTMLTextAreaElement | null) => {
    anchor.current = node;
    if (typeof ref === 'function') ref(node); else if (ref) ref.current = node;
  }, [ref]);
  return <VisualInstructionComposer key={JSON.stringify([auth.user?.id ?? 'local', visual.target])} {...visual} anchor={anchor}>{value => <>
    <ComposerArea {...props} ref={setAnchor}
      {...(value.active ? {
        input: value.draft?.request.utterance ?? '', onInputChange: value.setWords, inputDisabled: value.locked,
        inputLabel: 'Visual instruction', placeholder: 'What should change here?', literalInput: true,
        onSubmit: value.send, onSteer: value.send, onSlashCommand: () => {}, queueSaving: value.busy,
        promptStash: undefined, workerContext: undefined, attachedImages: [], attachedFiles: [],
        onUploadDiskFiles: value.locked ? undefined : value.upload, dragHandlers: undefined,
        attachmentContent: <VisualInstructionAttachments value={value} />,
        footerOverride: <VisualInstructionFooter value={value} />,
      } : {
        composerLeadingExtras: <>{props.composerLeadingExtras}{visual.active ? <VisualInstructionEntry value={value} /> : null}</>,
      })} />
    {visual.active ? <VisualInstructionFeedback value={value} /> : null}
  </>}</VisualInstructionComposer>;
});
