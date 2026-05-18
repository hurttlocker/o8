import type {
  LocalhostPreview,
  RegisteredRepo,
  TerminalTab,
  TerminalTabHandle,
} from '@/components/desktop/workspace-terminal/types';
import type { XtermPanelHandle } from '@/components/desktop/workspace-terminal/XtermPanel';
import {
  sameOrchestrationPacketBadge,
} from '@/components/desktop/workspace-terminal/utils';
import {
  buildOrchestratorLaneSnapshots,
} from '@/components/desktop/workspace-terminal/terminal-session-ops';
import {
  buildHistoryChatTab,
  computeChatRuntimeStatusUpdate,
  detectLocalhostPreviews,
} from '@/components/desktop/workspace-terminal/terminal-tab-handlers';

export interface ImperativeHandleDeps {
  tabsRef: React.RefObject<TerminalTab[]>;
  panelRefs: React.RefObject<Map<string, XtermPanelHandle>>;
  detectedPortsRef: React.MutableRefObject<Set<number>>;
  urlDetectionEnabledRef: React.MutableRefObject<boolean>;
  restoreSettledRef: React.MutableRefObject<boolean>;
  pendingRequestRef: React.MutableRefObject<Map<string, string>>;
  activeTabId: string;
  stateScope: string;
  preferredRepo: RegisteredRepo | null;
  setTabs: React.Dispatch<React.SetStateAction<TerminalTab[]>>;
  setPreviews: React.Dispatch<React.SetStateAction<LocalhostPreview[]>>;
  setActiveTabId: (id: string) => void;
  onPreviewDetected?: (preview: LocalhostPreview) => void;
  onOpenRepoDiff?: (repo: RegisteredRepo | null) => void;
  handleSessionCreated: (sessionName: string, requestId?: string) => boolean;
  openWorkspaceCliChatSession: (options: Parameters<TerminalTabHandle['openCliChatSession']>[0]) => string;
  openWorkspaceLlmChatSession: (options: {
    repo?: RegisteredRepo;
    initialText?: string;
    autoSend?: boolean;
    createNew?: boolean;
    label?: string;
    draftReason?: string;
    targetSessionKey?: string;
  }) => string;
  openWorkspaceInspectorTab: (canvasTab: NonNullable<TerminalTab['canvasTab']>, options?: { repo?: RegisteredRepo; createNew?: boolean }) => string;
  persistTabsNow: (currentTabs: TerminalTab[], currentActiveId: string) => void;
  sendTerminalDetach: (sessionName: string) => void;
  closeTabById: (tabId: string) => void;
}

export function buildTerminalTabHandle(deps: ImperativeHandleDeps): TerminalTabHandle {
  return {
    writeToTerminal: (sessionName, data) => {
      deps.panelRefs.current.get(sessionName)?.writeData(data);
      const now = Date.now();
      deps.setTabs((previous) => previous.map((tab) => (
        tab.tmuxSession === sessionName ? { ...tab, lastActivity: now } : tab
      )));
      if (deps.urlDetectionEnabledRef.current) {
        const newPreviews = detectLocalhostPreviews(data, sessionName, deps.tabsRef.current, deps.detectedPortsRef.current);
        for (const preview of newPreviews) {
          deps.onPreviewDetected?.(preview);
          deps.setPreviews((previous) => previous.some((p) => p.port === preview.port) ? previous : [...previous, preview]);
        }
      }
    },
    writeRaw: (sessionName, data) => {
      deps.panelRefs.current.get(sessionName)?.writeRaw(data);
    },
    showImage: (sessionName, imageB64, filename) => {
      deps.panelRefs.current.get(sessionName)?.showImage(imageB64, filename);
    },
    setTermError: (sessionName, error) => {
      deps.panelRefs.current.get(sessionName)?.setError(error);
    },
    setTermExited: (sessionName) => {
      deps.panelRefs.current.get(sessionName)?.setExited();
    },
    onSessionCreated: deps.handleSessionCreated,
    clearDetectedPreview: (port) => {
      deps.detectedPortsRef.current.delete(port);
      deps.setPreviews((previous) => previous.filter((preview) => preview.port !== port));
    },
    isRestoreSettled: () => deps.restoreSettledRef.current,
    openCliChatSession: (options) => deps.openWorkspaceCliChatSession(options),
    openLlmChatSession: (options) => deps.openWorkspaceLlmChatSession(options ?? {}),
    openHistoryChat: (historyTabId, title, historyRepo) => {
      const currentTab = deps.tabsRef.current.find((tab) => tab.id === deps.activeTabId)
        ?? deps.tabsRef.current.find((tab) => tab.kind === 'llm-chat')
        ?? deps.tabsRef.current[0];
      if (!currentTab) return '';
      const newTab = buildHistoryChatTab(currentTab, historyTabId, title, historyRepo);
      const previous = deps.tabsRef.current;
      const nextTabs = previous.some((tab) => tab.id === historyTabId)
        ? previous
        : [...previous, newTab];
      deps.tabsRef.current = nextTabs;
      deps.setTabs(nextTabs);
      deps.setActiveTabId(historyTabId);
      deps.persistTabsNow(nextTabs, historyTabId);
      return historyTabId;
    },
    injectIntoCliChat: (text, options) => (
      options?.targetSessionKey?.startsWith('llm-chat:')
        ? deps.openWorkspaceLlmChatSession({
            repo: options?.repo,
            initialText: text,
            autoSend: options?.autoSend ?? false,
            createNew: options?.createNew ?? false,
            label: options?.label,
            draftReason: options?.draftReason,
            targetSessionKey: options?.targetSessionKey,
          })
        : deps.openWorkspaceCliChatSession({
            runtime: options?.runtime,
            repo: options?.repo,
            modelId: options?.modelId,
            initialText: text,
            autoSend: options?.autoSend ?? false,
            createNew: options?.createNew ?? false,
            label: options?.label,
            draftReason: options?.draftReason,
            targetSessionKey: options?.targetSessionKey,
            orchestrationPacket: options?.orchestrationPacket,
            supervisorStatus: options?.supervisorStatus,
            autoArchiveOnIdle: options?.autoArchiveOnIdle,
          })
    ),
    focusTab: (tabId) => {
      const exists = deps.tabsRef.current.some((tab) => tab.id === tabId);
      if (!exists) return false;
      deps.setActiveTabId(tabId);
      deps.persistTabsNow(deps.tabsRef.current, tabId);
      return true;
    },
    focusTabRelative: (delta) => {
      const tabs = deps.tabsRef.current;
      if (tabs.length === 0) return false;
      const currentIndex = tabs.findIndex((tab) => tab.id === deps.activeTabId);
      const safeIndex = currentIndex >= 0 ? currentIndex : 0;
      const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
      const nextIndex = ((safeIndex + step) % tabs.length + tabs.length) % tabs.length;
      const nextTab = tabs[nextIndex];
      if (!nextTab) return false;
      deps.setActiveTabId(nextTab.id);
      deps.persistTabsNow(tabs, nextTab.id);
      return true;
    },
    focusTabAtIndex: (oneBasedIndex) => {
      const tabs = deps.tabsRef.current;
      if (tabs.length === 0) return false;
      const idx = Math.trunc(oneBasedIndex) - 1;
      if (idx < 0 || idx >= tabs.length) return false;
      const nextTab = tabs[idx];
      if (!nextTab) return false;
      deps.setActiveTabId(nextTab.id);
      deps.persistTabsNow(tabs, nextTab.id);
      return true;
    },
    closeActiveTab: () => {
      const activeId = deps.activeTabId;
      if (!activeId) return false;
      const exists = deps.tabsRef.current.some((tab) => tab.id === activeId);
      if (!exists) return false;
      deps.closeTabById(activeId);
      return true;
    },
    getTabsSnapshot: () => ({
      tabs: deps.tabsRef.current.map((tab) => ({
        id: tab.id,
        label: tab.label,
        kind: tab.kind,
        sessionKey: tab.chatSessionKey,
      })),
      activeTabId: deps.activeTabId,
    }),
    setOrchestrationPacket: (tabId, packet) => {
      // Match by tab.id first; fall back to chatSessionKey since
      // MCP-dispatched packets bind via lane.sessionKey and the dashboard
      // doesn't know the auto-generated tab id at packet-launch time.
      // Also fall back to the existing badge's packetId so terminal-state
      // updates (lane=null after merge) can still find the tab and flip
      // the badge from awaiting_review → released.
      let found = false;
      deps.setTabs((previous) => previous.map((tab) => {
        const matches = tab.id === tabId
          || tab.chatSessionKey === tabId
          || (tab.orchestrationPacket?.packetId && tab.orchestrationPacket.packetId === tabId);
        if (!matches) return tab;
        found = true;
        if (sameOrchestrationPacketBadge(tab.orchestrationPacket, packet) && (!packet || tab.autoArchiveOnIdle)) {
          return tab;
        }
        return {
          ...tab,
          orchestrationPacket: packet,
          lastActivity: packet?.status !== tab.orchestrationPacket?.status ? Date.now() : tab.lastActivity,
        };
      }));
      return found;
    },
    updateChatRuntimeStatus: (sessionKey, status, label) => {
      const normalizedTarget = sessionKey.trim();
      let found = false;
      deps.setTabs((previous) => previous.map((tab) => {
        const result = computeChatRuntimeStatusUpdate(tab, normalizedTarget, status, label);
        if (result.found) found = true;
        return result.updated;
      }));
      return found;
    },
    getChatTabSnapshots: () => buildOrchestratorLaneSnapshots(
      deps.tabsRef.current,
      deps.stateScope,
      deps.preferredRepo?.localPath ?? null,
      deps.preferredRepo?.branch ?? null,
    ),
    openWorkspaceDiff: () => {
      const activeWorkspaceTab = deps.tabsRef.current.find((tab) => tab.id === deps.activeTabId);
      const repo = activeWorkspaceTab?.repo ?? deps.tabsRef.current.find((tab) => tab.repo)?.repo ?? deps.preferredRepo ?? null;
      deps.onOpenRepoDiff?.(repo);
    },
    openInspectorTab: (canvasTab, options) => deps.openWorkspaceInspectorTab(canvasTab, options),
  };
}
