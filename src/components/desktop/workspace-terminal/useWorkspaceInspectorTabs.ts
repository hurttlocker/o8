import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { isWorkspaceUtilityKind } from '../canvas/workspace-utility-navigation';
import { computeInspectorTab } from './terminal-session-ops';
import type { RegisteredRepo, TerminalTab } from './types';

export function useWorkspaceInspectorTabs({ tabsRef, activeTabIdRef, setTabs, onSelectTab }: {
  tabsRef: MutableRefObject<TerminalTab[]>;
  activeTabIdRef: MutableRefObject<string>;
  setTabs: Dispatch<SetStateAction<TerminalTab[]>>;
  onSelectTab: (tabId: string) => void;
}) {
  return useCallback((canvasTab: NonNullable<TerminalTab['canvasTab']>, options?: { repo?: RegisteredRepo; createNew?: boolean }) => {
    if (isWorkspaceUtilityKind(canvasTab.kind)) {
      const existing = tabsRef.current.find((tab) => tab.kind === 'canvas' && tab.canvasTab?.id === canvasTab.id);
      const returnTabId = activeTabIdRef.current === existing?.id
        ? existing?.canvasTab?.meta?.returnTabId : activeTabIdRef.current;
      canvasTab = { ...canvasTab, meta: { ...canvasTab.meta, ...(returnTabId ? { returnTabId } : {}) } };
    }
    const result = computeInspectorTab(canvasTab, tabsRef.current, options);
    if (result.updatedTabId) {
      setTabs((previous) => previous.map((tab) => (
        tab.id === result.updatedTabId
          ? { ...tab, label: canvasTab.label, canvasTab, repo: options?.repo ?? tab.repo, lastActivity: Date.now() }
          : tab
      )));
    } else if (result.newTab) {
      setTabs((previous) => [result.newTab!, ...previous]);
    }
    if (result.activeTabId !== null) onSelectTab(result.activeTabId);
    return result.updatedTabId ?? result.newTab?.id ?? '';
  }, [activeTabIdRef, onSelectTab, setTabs, tabsRef]);
}
