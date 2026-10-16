'use client';

import { useCallback, useEffect, useRef, type MutableRefObject, type Dispatch, type SetStateAction } from 'react';
import { confirmTerminalClose } from '../workspace-terminal/terminal-close-confirm';
import type { ContextualPanelTab } from '../ContextualPanel';
import type { XtermPanelHandle } from '../BottomXtermPanel';

export function useContextualTabClose({ tabsRef, activeTabId, setTabs, setActiveTabId, sendTerminalDetach, xtermRefs, pendingTabIdsRef, pendingAgentsRef, pendingCommandsRef, pendingRequestRef, createShell, termWsConnected }: {
  tabsRef: MutableRefObject<ContextualPanelTab[]>;
  activeTabId: string;
  setTabs: Dispatch<SetStateAction<ContextualPanelTab[]>>;
  setActiveTabId: Dispatch<SetStateAction<string>>;
  sendTerminalDetach: (session: string) => void;
  xtermRefs: MutableRefObject<Map<string, XtermPanelHandle>>;
  pendingTabIdsRef: MutableRefObject<string[]>;
  pendingAgentsRef: MutableRefObject<Map<string, NonNullable<ContextualPanelTab['agentId']>>>;
  pendingCommandsRef: MutableRefObject<Map<string, string>>;
  pendingRequestRef: MutableRefObject<Map<string, string>>;
  createShell: () => void;
  termWsConnected: boolean;
}) {
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const closeNow = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((entry) => entry.id === tabId);
    if (!tab) return;
    if (tab.kind === 'terminal' && tab.tmuxSession) { sendTerminalDetach(tab.tmuxSession); xtermRefs.current.delete(tab.tmuxSession); }
    else if (tab.kind === 'terminal') {
      pendingTabIdsRef.current = pendingTabIdsRef.current.filter((entry) => entry !== tabId);
      pendingAgentsRef.current.delete(tabId); pendingCommandsRef.current.delete(tabId);
      for (const [requestId, pendingTabId] of pendingRequestRef.current) if (pendingTabId === tabId) pendingRequestRef.current.delete(requestId);
    }
    const index = tabsRef.current.findIndex((entry) => entry.id === tabId);
    const remaining = tabsRef.current.filter((entry) => entry.id !== tabId);
    tabsRef.current = remaining; setTabs(remaining);
    if (!remaining.length) { setActiveTabId(''); if (termWsConnected) createShell(); }
    else if (activeTabId === tabId) setActiveTabId(remaining[Math.min(index, remaining.length - 1)].id);
  }, [activeTabId, createShell, pendingAgentsRef, pendingCommandsRef, pendingRequestRef, pendingTabIdsRef, sendTerminalDetach, setActiveTabId, setTabs, tabsRef, termWsConnected, xtermRefs]);

  const closeTab = useCallback((id: string) => {
    const tab = tabsRef.current.find((entry) => entry.id === id);
    if (!tab || tab.kind !== 'terminal' || tab.readOnly) { closeNow(id); return; }
    void confirmTerminalClose({ ...tab, kind: 'terminal', cliAgent: tab.agentId }).then((confirmed) => {
      if (alive.current && confirmed && tabsRef.current.find((entry) => entry.id === id)?.tmuxSession === tab.tmuxSession) closeNow(id);
    });
  }, [closeNow, tabsRef]);

  const confirmPanelClose = useCallback(async () => {
    const terminals = tabsRef.current.filter((tab) => tab.kind === 'terminal' && !tab.readOnly);
    if (!terminals.length) return true;
    const first = terminals[0];
    const confirmed = await confirmTerminalClose({ ...first, kind: 'terminal', cliAgent: first.agentId, label: terminals.length > 1 ? `${terminals.length} terminals` : first.label }, terminals.length);
    const current = tabsRef.current.filter((tab) => tab.kind === 'terminal' && !tab.readOnly);
    return alive.current && confirmed && terminals.length === current.length && terminals.every((tab) => current.some((entry) => entry.id === tab.id && entry.tmuxSession === tab.tmuxSession));
  }, [tabsRef]);
  return { closeTab, confirmPanelClose };
}
