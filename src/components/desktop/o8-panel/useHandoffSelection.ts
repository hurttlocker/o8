import { useEffect, useState } from 'react';
import type { O8Tab } from './types';

export function useHandoffSelection(
  repoPath: string | null | undefined,
  onRepoPathChange: ((repoPath: string) => void) | undefined,
  onActiveTabChange: ((tab: O8Tab) => void) | undefined,
  onOpenO8Panel: ((options: { repoPath?: string | null; tab?: 'handoffs' }) => void) | undefined,
): { id: string | null; request: number; repoPath: string | null } {
  const [selection, setSelection] = useState<{ id: string | null; request: number; repoPath: string | null }>({ id: null, request: 0, repoPath: null });
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId?: string | null; repoPath?: string | null }>).detail ?? {};
      if (typeof detail.repoPath === 'string' && detail.repoPath && detail.repoPath !== repoPath) onRepoPathChange?.(detail.repoPath);
      setSelection((current) => ({
        id: typeof detail.conversationId === 'string' ? detail.conversationId : null,
        request: current.request + 1,
        repoPath: detail.repoPath ?? repoPath ?? null,
      }));
      onOpenO8Panel?.({ tab: 'handoffs', repoPath: detail.repoPath });
      onActiveTabChange?.('handoffs');
    };
    window.addEventListener('o8:open-handoffs', handler);
    return () => window.removeEventListener('o8:open-handoffs', handler);
  }, [onActiveTabChange, onOpenO8Panel, onRepoPathChange, repoPath]);
  return selection;
}
