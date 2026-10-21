'use client';

import { useCallback, useState } from 'react';

export interface RightPrTab {
  id: string;
  number: number;
  repo: string | null;
  repoPath: string | null;
}

export function rightPrTabId(number: number, repo?: string | null, repoPath?: string | null): string {
  return `${repo || repoPath || 'default'}#${number}`;
}

export function useRightPrTabs() {
  const [tabs, setTabs] = useState<RightPrTab[]>([]);
  const open = useCallback((number: number, repo?: string | null, repoPath?: string | null) => {
    const tab = { id: rightPrTabId(number, repo, repoPath), number, repo: repo || null, repoPath: repoPath || null };
    setTabs((current) => current.some((entry) => entry.id === tab.id)
      ? current.map((entry) => entry.id === tab.id && entry.repoPath !== tab.repoPath ? tab : entry)
      : [...current, tab]);
  }, []);
  const close = useCallback((id: string) => setTabs((current) => current.filter((tab) => tab.id !== id)), []);
  return { tabs, open, close };
}
