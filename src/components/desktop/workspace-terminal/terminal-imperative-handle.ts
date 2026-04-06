import type {
  LocalhostPreview,
  RegisteredRepo,
  TerminalTab,
  TerminalTabHandle,
} from '@/components/desktop/workspace-terminal/types';
import type { XtermPanelHandle } from '@/components/desktop/workspace-terminal/XtermPanel';
import {
  isAgentRuntimeTab,
  normalizeWorkspaceChatSessionKey,
  resolveWorkspaceChatLaneStatus,
  sameOrchestrationPacketBadge,
} from '@/components/desktop/workspace-terminal/utils';
import {
  buildOrchestratorLaneSnapshots,
} from '@/components/desktop/workspace-terminal/terminal-session-ops';
import {
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
    setOrchestrationPacket: (tabId, packet) => {
      let found = false;
      deps.setTabs((previous) => previous.map((tab) => {
        if (tab.id !== tabId) return tab;
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
