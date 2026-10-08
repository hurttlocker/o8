import { useCallback, useRef, useState } from 'react';
import { buildRepoRequestHeaders, type PreferredRepoContext } from './shared';

export function useChatFileApply(preferredRepo?: PreferredRepoContext | null) {
  const [applyModal, setApplyModal] = useState<{ code: string; language: string } | null>(null);
  const [applyPath, setApplyPath] = useState('');
  const [applyStatus, setApplyStatus] = useState<'idle' | 'applying' | 'done' | 'error'>('idle');
  const [applyFileSuggestions, setApplyFileSuggestions] = useState<Array<{ path: string }>>([]);
  const [applyFileIndex, setApplyFileIndex] = useState(0);
  const applySearchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleApplyToFile = useCallback((code: string, language: string) => {
    setApplyModal({ code, language });
    setApplyPath('');
    setApplyStatus('idle');
    setApplyFileSuggestions([]);
  }, []);

  const handleApplyDiff = useCallback(async (diffText: string) => {
    const repoPath = preferredRepo?.localPath?.trim();
    if (!repoPath) {
      console.error('[diff-card] Failed to apply diff:', new Error('No active repository selected.'));
      return;
    }

    try {
      const response = await fetch('/api/lanes/apply-diff', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildRepoRequestHeaders(preferredRepo ?? null),
        },
        body: JSON.stringify({ diffText, repoPath }),
      });
      const result = await response.json().catch(() => null) as { laneId?: string; error?: string; note?: string } | null;
      if (!response.ok || !result?.laneId) {
        throw new Error(result?.error || result?.note || 'Apply failed');
      }
      window.dispatchEvent(new CustomEvent('o8:lane-lifecycle'));
    } catch (error) {
      console.error('[diff-card] Failed to apply diff:', error);
    }
  }, [preferredRepo]);

  const searchApplyFiles = useCallback((query: string) => {
    if (applySearchTimeout.current) {
      clearTimeout(applySearchTimeout.current);
    }
    if (!query.trim()) {
      setApplyFileSuggestions([]);
      return;
    }
    applySearchTimeout.current = setTimeout(async () => {
      try {
        const response = await fetch(`/api/v2/context/files?q=${encodeURIComponent(query)}`, {
          headers: buildRepoRequestHeaders(preferredRepo ?? null),
        });
        if (response.ok) {
          const data = await response.json();
          setApplyFileSuggestions(data.files ?? []);
          setApplyFileIndex(0);
        }
      } catch {}
    }, 100);
  }, [preferredRepo]);

  const doApply = useCallback(async () => {
    if (!applyModal || !applyPath.trim()) return;
    setApplyStatus('applying');
    try {
      const response = await fetch('/api/v2/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: applyPath.trim(),
          content: applyModal.code,
          workspace: preferredRepo?.localPath ?? undefined,
        }),
      });
      if (response.ok) {
        setApplyStatus('done');
        setTimeout(() => {
          setApplyModal(null);
          setApplyStatus('idle');
        }, 1500);
      } else {
        setApplyStatus('error');
      }
    } catch {
      setApplyStatus('error');
    }
  }, [applyModal, applyPath, preferredRepo]);

  return { applyModal, setApplyModal, applyPath, setApplyPath, applyStatus, applyFileSuggestions, setApplyFileSuggestions, applyFileIndex, setApplyFileIndex, handleApplyToFile, handleApplyDiff, searchApplyFiles, doApply };
}
