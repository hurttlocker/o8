'use client';
/* eslint-disable react-hooks/set-state-in-effect -- synchronize composer state with external draft injection and host visibility transitions */

import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { ContextualConversation } from './contextual-turn';

/** Apply an inserted draft once, and preserve drafts owned by contextual chats. */
export function useComposerDraftLifecycle({ open, input, draftInjection, contextualConversation, setInput, setPreEnhanceInput, inputRef }: {
  open: boolean; input: string; draftInjection?: { id: string; text: string } | null;
  contextualConversation?: ContextualConversation;
  setInput: Dispatch<SetStateAction<string>>; setPreEnhanceInput: Dispatch<SetStateAction<string | null>>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const appliedInjection = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !draftInjection?.id || appliedInjection.current === draftInjection.id) return;
    appliedInjection.current = draftInjection.id;
    setInput((previous) => previous.trim() ? `${previous.trimEnd()}\n\n${draftInjection.text}\n\n` : `${draftInjection.text}\n\n`);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(timer);
  }, [draftInjection?.id, draftInjection?.text, inputRef, open, setInput]);
  const onDraftChange = contextualConversation?.onDraftChange;
  useEffect(() => { onDraftChange?.(input); }, [input, onDraftChange]);
  const previousOpen = useRef(open);
  const inputAtBlur = useRef('');
  const lastDraftId = useRef(draftInjection?.id ?? null);
  const [showDraftClearedToast, setShowDraftClearedToast] = useState(false);
  const toastTimer = useRef<number | null>(null);
  useEffect(() => () => { if (toastTimer.current !== null) window.clearTimeout(toastTimer.current); }, []);
  useEffect(() => {
    const wasOpen = previousOpen.current;
    previousOpen.current = open;
    if (wasOpen && !open) { inputAtBlur.current = input; lastDraftId.current = draftInjection?.id ?? null; return; }
    if (!open || wasOpen) return;
    const newDraft = (draftInjection?.id ?? null) !== lastDraftId.current;
    if (inputAtBlur.current.trim() && !newDraft && !contextualConversation) {
      setInput(''); setPreEnhanceInput(null); setShowDraftClearedToast(true);
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => { setShowDraftClearedToast(false); toastTimer.current = null; }, 1800);
    }
    inputAtBlur.current = ''; lastDraftId.current = draftInjection?.id ?? null;
  }, [contextualConversation, draftInjection?.id, input, open, setInput, setPreEnhanceInput]);
  return showDraftClearedToast;
}
