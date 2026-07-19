'use client';

import { useCallback, useMemo, useState, type ChangeEvent, type RefObject } from 'react';
import { QuickActionPalette } from '@/components/desktop/orchestrator/QuickActionPalette';
import type { QuickAction } from '@/lib/orchestrator/quick-actions';

const CLEAR_THREAD_PROMPT = 'Start a fresh orchestrator session and clear the current thread context.';

/** Slash input belongs to the palette; it must never fall through as a raw turn. */
export function isCanvasSlashInput(value: string): boolean {
  return value.trimStart().startsWith('/');
}

/** Canvas uses the shared editable templates. Normalize the palette's one local
 * slash command into prose because canvas does not own the desktop clear seam. */
export function canvasQuickActionDraft(action: QuickAction): string {
  return action.promptTemplate.startsWith('/') ? CLEAR_THREAD_PROMPT : action.promptTemplate;
}

export function useCanvasQuickActions(
  setComposerValue: (value: string) => void,
  composerInputRef: RefObject<HTMLTextAreaElement | null>,
) {
  const [open, setOpen] = useState(false);
  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => composerInputRef.current?.focus());
  }, [composerInputRef]);
  const close = useCallback(() => {
    setOpen(false);
    focusComposer();
  }, [focusComposer]);
  const onChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setComposerValue(value);
    if (isCanvasSlashInput(value)) setOpen(true);
  }, [setComposerValue]);
  const guardSubmit = useCallback((value: string) => {
    if (!isCanvasSlashInput(value)) return false;
    setOpen(true);
    return true;
  }, []);
  const onPick = useCallback((action: QuickAction) => {
    setComposerValue(canvasQuickActionDraft(action));
    setOpen(false);
    focusComposer();
  }, [focusComposer, setComposerValue]);
  const palette = useMemo(() => (
    <QuickActionPalette open={open} onClose={close} onPick={onPick} />
  ), [close, onPick, open]);
  return { guardSubmit, onChange, palette };
}
