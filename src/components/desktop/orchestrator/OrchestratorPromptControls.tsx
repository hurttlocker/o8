'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  insertPromptIntoActiveComposer,
  OPEN_PROMPT_LIBRARY_EVENT,
  recordSavedPromptUse,
  SAVE_PROMPT_LIBRARY_EVENT,
  type PromptLibraryEntry,
} from '@/lib/prompt-library/client';
import type { QuickAction } from '@/lib/orchestrator/quick-actions';
import { PromptLibraryPalette } from './PromptLibraryPalette';
import { QuickActionPalette } from './QuickActionPalette';
import { SavePromptDialog } from './SavePromptDialog';

export function OrchestratorPromptControls({ active, repoPath, repoName, onDraft }: {
  active: boolean;
  repoPath: string | null;
  repoName: string;
  onDraft: (text: string, sourceId: string) => void;
}) {
  const [quickOpen, setQuickOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [saveBody, setSaveBody] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const openPrompts = () => {
      setQuickOpen(false);
      setPromptOpen(true);
    };
    const savePrompt = (event: Event) => {
      const detail = (event as CustomEvent<{ body?: unknown }>).detail;
      if (typeof detail?.body === 'string' && detail.body.trim()) setSaveBody(detail.body);
    };
    window.addEventListener(OPEN_PROMPT_LIBRARY_EVENT, openPrompts);
    window.addEventListener(SAVE_PROMPT_LIBRARY_EVENT, savePrompt);
    return () => {
      window.removeEventListener(OPEN_PROMPT_LIBRARY_EVENT, openPrompts);
      window.removeEventListener(SAVE_PROMPT_LIBRARY_EVENT, savePrompt);
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const keyMatches = event.key === 'k' || event.key === 'K';
      if (!keyMatches || !event.shiftKey || !(event.metaKey || event.ctrlKey)) return;
      if ((document.activeElement as HTMLElement | null)?.tagName === 'TEXTAREA') return;
      event.preventDefault();
      setQuickOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active]);

  const pickQuickAction = useCallback((action: QuickAction) => {
    if (action.id === 'prompts') {
      setPromptOpen(true);
      return;
    }
    onDraft(action.promptTemplate, `quick-action-${action.id}`);
  }, [onDraft]);

  const pickPrompt = useCallback((prompt: PromptLibraryEntry) => {
    if (!insertPromptIntoActiveComposer(prompt.body)) {
      onDraft(prompt.body, `saved-prompt-${prompt.id}`);
    }
    void recordSavedPromptUse(prompt.id).catch(() => {});
  }, [onDraft]);

  return (
    <>
      <QuickActionPalette open={quickOpen} onClose={() => setQuickOpen(false)} onPick={pickQuickAction} />
      <PromptLibraryPalette open={promptOpen} repoPath={repoPath} onClose={() => setPromptOpen(false)} onPick={pickPrompt} />
      {saveBody ? (
        <SavePromptDialog body={saveBody} repoPath={repoPath} repoName={repoName} onClose={() => setSaveBody(null)} />
      ) : null}
    </>
  );
}
