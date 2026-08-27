'use client';

import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { TerminalTab } from '@/components/desktop/workspace-terminal/types';

export function useWorkspaceTabLabelUpdater(
  setTabs: Dispatch<SetStateAction<TerminalTab[]>>,
  tabsRef: MutableRefObject<TerminalTab[]>,
) {
  return useCallback((
    tabId: string,
    label: string,
    options?: { threadId?: string | null; source?: 'auto' | 'user' },
  ) => {
    const nextLabel = label.trim();
    if (!nextLabel) return;
    setTabs((previous) => {
      let changed = false;
      const next = previous.map((tab) => {
        if (tab.id !== tabId) return tab;
        if (
          options?.threadId
          && tab.kind === 'orchestrator'
          && tab.orchestratorThreadId
          && tab.orchestratorThreadId !== options.threadId
        ) {
          return tab;
        }
        if (options?.source !== 'user' && tab.labelSource === 'user') return tab;
        const labelSource = options?.source === 'user' ? 'user' as const : tab.labelSource;
        if (tab.label === nextLabel && tab.labelSource === labelSource) return tab;
        changed = true;
        return { ...tab, label: nextLabel, labelSource };
      });
      if (changed) tabsRef.current = next;
      return changed ? next : previous;
    });
  }, [setTabs, tabsRef]);
}
