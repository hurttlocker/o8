'use client';

import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { buildNewChatGPTPlanTab, buildNewLlmChatTab } from './terminal-tab-handlers';
import type { RegisteredRepo, TerminalTab } from './types';

export function useTextChatTabs({ preferredRepo, tabsRef, setTabs, persistTabsNow, setActiveTabIdFromUser }: {
  preferredRepo?: RegisteredRepo | null;
  tabsRef: MutableRefObject<TerminalTab[]>;
  setTabs: Dispatch<SetStateAction<TerminalTab[]>>;
  persistTabsNow: (tabs: TerminalTab[], activeTabId: string) => void;
  setActiveTabIdFromUser: (tabId: string) => void;
}) {
  const append = useCallback((tab: TerminalTab) => {
    const nextTabs = [...tabsRef.current, tab];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    persistTabsNow(nextTabs, tab.id);
    setActiveTabIdFromUser(tab.id);
  }, [persistTabsNow, setActiveTabIdFromUser, setTabs, tabsRef]);
  const handleNewLLMChatTab = useCallback((repo?: RegisteredRepo) => append(buildNewLlmChatTab(repo ?? preferredRepo ?? undefined)), [append, preferredRepo]);
  const handleNewChatGPTPlanTab = useCallback(() => append(buildNewChatGPTPlanTab()), [append]);
  return { handleNewLLMChatTab, handleNewChatGPTPlanTab };
}
