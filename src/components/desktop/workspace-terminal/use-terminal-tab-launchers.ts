import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { computeNewTerminalTab } from './terminal-tab-handlers';
import type { RegisteredRepo, RemoteTerminalDetails, TerminalTab } from './types';

export function useTerminalTabLaunchers({
  tabsRef,
  pendingCliCommands,
  setTabs,
  setActiveTabIdFromUser,
  requestTerminalForTab,
}: {
  tabsRef: MutableRefObject<TerminalTab[]>;
  pendingCliCommands: MutableRefObject<Map<string, string>>;
  setTabs: Dispatch<SetStateAction<TerminalTab[]>>;
  setActiveTabIdFromUser: (tabId: string) => void;
  requestTerminalForTab: (tabId: string, command: string | undefined, caller: 'new-tab') => void;
}) {
  const openWorkspaceTerminalTab = useCallback((agentId: string, repo?: RegisteredRepo): string => {
    const result = computeNewTerminalTab(agentId, repo, tabsRef.current);
    if (!result.newTab) return '';
    if (result.cliCommand) pendingCliCommands.current.set(result.newTab.id, result.cliCommand);
    const nextTabs = [result.newTab, ...tabsRef.current];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveTabIdFromUser(result.activeTabId);
    requestTerminalForTab(result.newTab.id, result.cliCommand ?? undefined, 'new-tab');
    return result.activeTabId;
  }, [pendingCliCommands, requestTerminalForTab, setActiveTabIdFromUser, setTabs, tabsRef]);

  const openRemoteTerminalTab = useCallback((details: RemoteTerminalDetails): string => {
    const result = computeNewTerminalTab('shell', undefined, tabsRef.current);
    if (!result.newTab) return '';
    const newTab: TerminalTab = {
      ...result.newTab,
      label: `${details.machineLabel} / ${details.sessionId}`,
      // Keep the local PTY writable for the launch command while locking user input.
      remoteLaunchPending: true,
      remoteMachine: { id: details.machineId, label: details.machineLabel, sessionId: details.sessionId },
    };
    const nextTabs = [newTab, ...tabsRef.current];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveTabIdFromUser(newTab.id);
    requestTerminalForTab(newTab.id, details.command, 'new-tab');
    return newTab.id;
  }, [requestTerminalForTab, setActiveTabIdFromUser, setTabs, tabsRef]);

  return { openWorkspaceTerminalTab, openRemoteTerminalTab };
}
