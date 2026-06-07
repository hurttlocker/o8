'use client';

import { useCallback, useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type {
  LocalhostPreview,
  TerminalTab,
} from '@/components/desktop/workspace-terminal/types';
import type { XtermPanelHandle } from '@/components/desktop/workspace-terminal/XtermPanel';
import {
  archivePacket,
  computeCloseTab,
  isTabFinishedForCleanup,
} from '@/components/desktop/workspace-terminal/terminal-tab-handlers';
import { clearSessionTileStorage } from '@/components/desktop/workspace-terminal/use-session-tiles';

export interface TabCleanupResult {
  closedCount: number;
  closedTabs: TerminalTab[];
}

interface UseWorkspaceTabCleanupOptions {
  activeTabId: string;
  detectedPortsRef: MutableRefObject<Set<number>>;
  effectiveActiveTabId: string;
  panelRefs: MutableRefObject<Map<string, XtermPanelHandle>>;
  pendingCliCommands: MutableRefObject<Map<string, string>>;
  pendingRequestRef: MutableRefObject<Map<string, string>>;
  pendingSessionsRef: MutableRefObject<Set<string>>;
  sendTerminalDetach: (sessionName: string) => void;
  setActiveTabIdFromUser: (next: string) => void;
  setPreviews: Dispatch<SetStateAction<LocalhostPreview[]>>;
  setTabs: Dispatch<SetStateAction<TerminalTab[]>>;
  tabs: TerminalTab[];
  tabsRef: MutableRefObject<TerminalTab[]>;
}

export function useWorkspaceTabCleanup({
  activeTabId,
  detectedPortsRef,
  effectiveActiveTabId,
  panelRefs,
  pendingCliCommands,
  pendingRequestRef,
  pendingSessionsRef,
  sendTerminalDetach,
  setActiveTabIdFromUser,
  setPreviews,
  setTabs,
  tabs,
  tabsRef,
}: UseWorkspaceTabCleanupOptions) {
  const finishedTabCount = useMemo(
    () => tabs.filter((tab) => tab.id !== effectiveActiveTabId && isTabFinishedForCleanup(tab)).length,
    [effectiveActiveTabId, tabs],
  );

  const handleCloseTab = useCallback((tabId: string) => {
    const result = computeCloseTab(tabsRef.current, tabId, activeTabId);
    if (!result) return;
    if (result.detachedSession) {
      sendTerminalDetach(result.detachedSession);
      panelRefs.current.delete(result.detachedSession);
    }
    if (pendingSessionsRef.current.has(tabId)) {
      pendingSessionsRef.current.delete(tabId);
    }
    pendingCliCommands.current.delete(tabId);
    clearSessionTileStorage(tabId);
    for (const [requestId, pendingTabId] of pendingRequestRef.current) {
      if (pendingTabId === tabId) pendingRequestRef.current.delete(requestId);
    }
    tabsRef.current = result.remaining;
    setTabs(result.remaining);
    if (result.nextActiveId !== null) setActiveTabIdFromUser(result.nextActiveId);
    setPreviews((prev) => {
      const toRemove = prev.filter((p) => p.tabId === tabId);
      toRemove.forEach((p) => detectedPortsRef.current.delete(p.port));
      return prev.filter((p) => p.tabId !== tabId);
    });
  }, [
    activeTabId,
    detectedPortsRef,
    panelRefs,
    pendingCliCommands,
    pendingRequestRef,
    pendingSessionsRef,
    sendTerminalDetach,
    setActiveTabIdFromUser,
    setPreviews,
    setTabs,
    tabsRef,
  ]);

  const archiveWorkspaceTab = useCallback((tabId: string, packetId?: string | null) => {
    handleCloseTab(tabId);
    archivePacket(packetId);
  }, [handleCloseTab]);

  const cleanupFinishedTabs = useCallback((): TabCleanupResult => {
    const closedTabs = tabsRef.current.filter((tab) => (
      tab.id !== effectiveActiveTabId && isTabFinishedForCleanup(tab)
    ));
    for (const tab of closedTabs) {
      archiveWorkspaceTab(tab.id, tab.orchestrationPacket?.packetId ?? null);
    }
    return { closedCount: closedTabs.length, closedTabs };
  }, [archiveWorkspaceTab, effectiveActiveTabId, tabsRef]);

  const undoCleanup = useCallback((closedTabs: TerminalTab[]) => {
    if (closedTabs.length === 0) return;
    setTabs((previous) => {
      const existingIds = new Set(previous.map((tab) => tab.id));
      const restoredTabs = closedTabs.filter((tab) => !existingIds.has(tab.id));
      if (restoredTabs.length === 0) return previous;
      const nextTabs = [...previous, ...restoredTabs];
      tabsRef.current = nextTabs;
      return nextTabs;
    });
  }, [setTabs, tabsRef]);

  return {
    archiveWorkspaceTab,
    cleanupFinishedTabs,
    finishedTabCount,
    handleCloseTab,
    undoCleanup,
  };
}
