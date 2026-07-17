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
    previewImageDataUri?: string;
    targetSessionKey?: string;
  }) => string;
  openWorkspaceOrchestratorTab: (repo?: RegisteredRepo | null) => string;
  openWorkspaceTerminalTab: (agentId: string, repo?: RegisteredRepo) => string;
  openWorkspaceInspectorTab: (canvasTab: NonNullable<TerminalTab['canvasTab']>, options?: { repo?: RegisteredRepo; createNew?: boolean }) => string;
  persistTabsNow: (currentTabs: TerminalTab[], currentActiveId: string) => void;
  sendTerminalDetach: (sessionName: string) => void;
  closeTabById: (tabId: string) => void;
  recordTerminalActivity: (sessionName: string, timestamp?: number) => void;
}

export function buildTerminalTabHandle(deps: ImperativeHandleDeps): TerminalTabHandle {
  return {
    writeToTerminal: (sessionName, data) => {
      deps.panelRefs.current.get(sessionName)?.writeData(data);
      const now = Date.now();
      deps.recordTerminalActivity(sessionName, now);
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
    openOrchestratorTab: (repo) => deps.openWorkspaceOrchestratorTab(repo),
    openTerminalTab: (repo) => deps.openWorkspaceTerminalTab('shell', repo),
    openHistoryChat: (historyTabId, title, historyRepo) => {
      const currentTab = deps.tabsRef.current.find((tab) => tab.id === deps.activeTabId)
        ?? deps.tabsRef.current.find((tab) => tab.kind === 'llm-chat')
        ?? deps.tabsRef.current[0];
      if (!currentTab) return '';
      const newTab = buildHistoryChatTab(currentTab, historyTabId, title, historyRepo);
      const previous = deps.tabsRef.current;
      const nextTabs = previous.some((tab) => tab.id === historyTabId)
        ? previous.map((tab) => (
            tab.id === historyTabId
              ? { ...tab, label: title, repo: newTab.repo ?? tab.repo }
              : tab
          ))
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
            previewImageDataUri: options?.previewImageDataUri,
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
            previewImageDataUri: options?.previewImageDataUri,
            targetSessionKey: options?.targetSessionKey,
            orchestrationPacket: options?.orchestrationPacket,
            supervisorStatus: options?.supervisorStatus,
            autoArchiveOnIdle: options?.autoArchiveOnIdle,
          })
    ),
    injectIntoOrchestrator: (tabId, text, options) => {
      const target = deps.tabsRef.current.find((tab) => tab.id === tabId && tab.kind === 'orchestrator');
      const nextText = text.trim();
      if (!target || !nextText) return false;
      const nextTabs = deps.tabsRef.current.map((tab) => (
        tab.id === tabId
          ? {
              ...tab,
              lastActivity: Date.now(),
              orchestratorTurnInjection: {
                id: `orchestrator-turn-${Date.now()}`,
                text: nextText,
                previewImageDataUri: options?.previewImageDataUri,
              },
            }
          : tab
      ));
      deps.tabsRef.current = nextTabs;
      deps.setTabs(nextTabs);
      return true;
    },
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
        orchestratorThreadId: tab.orchestratorThreadId,
        repoPath: tab.repo?.localPath,
        lastActivity: tab.lastActivity,
        mode: tab.mode,
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
    // Option D — the twin of setOrchestrationPacket, for the tab LABEL. The
    // packet badge already self-heals when async data lands; the label didn't,
    // so it froze on its open-time fallback. This writes the freshly-derived
    // canonical label ONLY when the tab is still auto-sourced (labelSource !==
    // 'user'; absent ⇒ auto) AND the value actually changed (no needless setTabs
    // → no re-render churn). Matched by the same keys setOrchestrationPacket uses.
    setTabLabelIfAuto: (match, label) => {
      const next = label.trim();
      if (!next) return false;
      const keys = [match.sessionKey, match.packetId].filter((k): k is string => Boolean(k));
      if (keys.length === 0) return false;
      // Find the target first (no setTabs yet) so we only schedule a state
      // update when something ACTUALLY changes — `previous.map` always returns a
      // fresh array, which would re-render on every packet tick otherwise.
      const target = deps.tabsRef.current.find((tab) => keys.some((key) => (
        tab.id === key
        || tab.chatSessionKey === key
        || tab.orchestrationPacket?.packetId === key
      )));
      if (!target) return false;
      // Matched — but frozen by a user rename, or already correct: nothing to do.
      if (target.labelSource === 'user' || target.label === next) return true;
      deps.setTabs((previous) => previous.map((tab) => (
        tab.id === target.id ? { ...tab, label: next, labelSource: 'auto' as const } : tab
      )));
      return true;
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
    // #1293 — close the orphaned chat tab when its lane retires. Matches by the
    // same keys setOrchestrationPacket uses (tab id / chatSessionKey / bound
    // packetId), since a retired lane's payload may carry only sessionKey or
    // only packetId. Reuses the already-wired closeTabById.
    closeChatTabForRetiredLane: (match) => {
      const keys = [match.sessionKey, match.packetId].filter((k): k is string => Boolean(k));
      if (keys.length === 0) return false;
      const target = deps.tabsRef.current.find((tab) => tab.kind === 'chat' && keys.some((key) => (
        tab.id === key
        || tab.chatSessionKey === key
        || tab.orchestrationPacket?.packetId === key
      )));
      if (!target) return false;
      deps.closeTabById(target.id);
      return true;
    },
    // #1293 Part C — sweep tabs whose lane ALREADY retired (not just live
    // retire events). A tab whose lane archived BEFORE the lane-lifecycle
    // listener mounted (a reset on a prior build, a page reload, or a WS
    // dispatch-replay that resurrects a dispatched tab on boot) would otherwise
    // persist as a zombie. A dispatched packet tab is keyed by its bound
    // packetId — which is NEVER a sessionKey — so the prior sessionKey-only set
    // silently missed every packet tab (the #943 / #1293 zombies). Match
    // id / chatSessionKey against archived SESSION keys, and the bound packetId
    // against archived PACKET ids (the same split the sidebar uses to hide
    // retired packet chips).
    closeRetiredChatTabs: ({ sessionKeys, packetIds }) => {
      if (sessionKeys.size === 0 && packetIds.size === 0) return 0;
      const targets = deps.tabsRef.current.filter((tab) => tab.kind === 'chat' && (
        sessionKeys.has(tab.id)
        || (tab.chatSessionKey != null && sessionKeys.has(tab.chatSessionKey))
        || (tab.orchestrationPacket?.packetId != null && packetIds.has(tab.orchestrationPacket.packetId))
      ));
      for (const tab of targets) deps.closeTabById(tab.id);
      return targets.length;
    },
    openWorkspaceDiff: () => {
      const activeWorkspaceTab = deps.tabsRef.current.find((tab) => tab.id === deps.activeTabId);
      const repo = activeWorkspaceTab?.repo ?? deps.tabsRef.current.find((tab) => tab.repo)?.repo ?? deps.preferredRepo ?? null;
      deps.onOpenRepoDiff?.(repo);
    },
    openInspectorTab: (canvasTab, options) => deps.openWorkspaceInspectorTab(canvasTab, options),
  };
}
