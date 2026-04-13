import type { PersistedChatCheckpoint, PersistedTabState } from '@/lib/terminal/tab-state';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import {
  adHocLaneTitle,
} from '@/lib/orchestrator/display';
import {
  persistOrchestratorMissionState,
  readOrchestratorMissionState,
} from '@/lib/orchestrator/store';
import { ANSI_RE, CLAUDE_CLI_MODELS, CODEX_CLI_MODELS, CLI_AGENTS, IGNORED_PORTS, LOCALHOST_RE } from '@/components/desktop/workspace-terminal/constants';
import type {
  LocalhostPreview,
  RegisteredRepo,
  TerminalTab,
} from '@/components/desktop/workspace-terminal/types';
import {
  buildCheckpointLabel,
  createWorkspaceTabId,
  generateLlmChatTabId,
  normalizeWorkspaceChatSessionKey,
  packetStatusFromSupervisorStatus,
  resolveWorkspaceChatLaneStatus,
  sameTranscriptMessages,
} from '@/components/desktop/workspace-terminal/utils';

/* ------------------------------------------------------------------ */
/*  handleNewTab (terminal)                                            */
/* ------------------------------------------------------------------ */

export interface NewTerminalTabResult {
  newTab: TerminalTab | null;
  activeTabId: string;
  cliCommand: string | null;
}

export function computeNewTerminalTab(
  agentId: string,
  repo?: RegisteredRepo,
): NewTerminalTabResult {
  const agent = CLI_AGENTS.find((candidate) => candidate.id === agentId);
  if (!agent) return { newTab: null, activeTabId: '', cliCommand: null };

  const tabId = createWorkspaceTabId('terminal');
  const now = Date.now();
  const newTab: TerminalTab = {
    id: tabId,
    label: agent.label,
    kind: 'terminal',
    tmuxSession: null,
    cliAgent: agentId,
    repo,
    createdAt: now,
    lastActivity: now,
  };

  let cliCommand: string | null = null;
  if (agent.command || repo) {
    const parts: string[] = [];
    if (repo) parts.push(`cd ${repo.localPath}`);
    if (agent.command) parts.push(agent.command);
    cliCommand = parts.join(' && ');
  }

  return { newTab, activeTabId: tabId, cliCommand };
}

/* ------------------------------------------------------------------ */
/*  handleNewChatTab                                                   */
/* ------------------------------------------------------------------ */

export function buildNewChatTab(
  runtime: 'codex' | 'claude-code',
  repo?: RegisteredRepo,
): TerminalTab {
  const tabId = createWorkspaceTabId('chat');
  const now = Date.now();
  return {
    id: tabId,
    label: adHocLaneTitle('chat'),
    kind: 'chat',
    tmuxSession: null,
    chatRuntime: runtime,
    chatContinueLatest: false,
    chatModel: runtime === 'claude-code' ? CLAUDE_CLI_MODELS[0].id : CODEX_CLI_MODELS[0].id,
    repo,
    linkedIssue: null,
    createdAt: now,
    lastActivity: now,
    chatMessages: [],
    chatCheckpoints: [],
  };
}

/* ------------------------------------------------------------------ */
/*  handleNewLLMChatTab                                                */
/* ------------------------------------------------------------------ */

export function buildNewLlmChatTab(
  repo?: RegisteredRepo,
): TerminalTab {
  const tabId = generateLlmChatTabId();
  const now = Date.now();
  return {
    id: tabId,
    label: adHocLaneTitle('llm-chat'),
    kind: 'llm-chat',
    tmuxSession: null,
    repo,
    linkedIssue: null,
    createdAt: now,
    lastActivity: now,
  };
}

/* ------------------------------------------------------------------ */
/*  handleUpdateChatMessages                                           */
/* ------------------------------------------------------------------ */

export function computeUpdatedChatMessages(
  tab: TerminalTab,
  messages: MobileTranscriptEntry[],
): TerminalTab {
  const previousMessages = tab.chatMessages ?? [];
  if (sameTranscriptMessages(previousMessages, messages)) {
    return previousMessages === messages ? tab : { ...tab, chatMessages: messages };
  }
  const latestTimestamp = messages.reduce((max, entry) => Math.max(max, entry.timestamp ?? 0), 0);
  return {
    ...tab,
    chatMessages: messages,
    supervisorStatus: tab.supervisorStatus === 'launched' ? 'running' : tab.supervisorStatus,
    lastActivity: latestTimestamp > 0 ? latestTimestamp : Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/*  handleUpdateChatSessionKey                                         */
/* ------------------------------------------------------------------ */

export function computeUpdatedChatSessionKey(
  tab: TerminalTab,
  sessionKey: string,
): TerminalTab {
  return {
    ...tab,
    chatSessionKey: tab.chatRuntime
      ? (normalizeWorkspaceChatSessionKey(tab.chatRuntime, sessionKey) ?? sessionKey)
      : sessionKey,
  };
}

/* ------------------------------------------------------------------ */
/*  handleSaveCheckpoint                                               */
/* ------------------------------------------------------------------ */

export function computeSaveCheckpoint(tab: TerminalTab): TerminalTab {
  if (tab.kind !== 'chat') return tab;
  const messages = (tab.chatMessages ?? []).filter((entry) => !entry.id.startsWith('stream:'));
  if (messages.length === 0) return tab;
  const checkpoint: PersistedChatCheckpoint = {
    id: `checkpoint-${Date.now()}`,
    label: buildCheckpointLabel(tab, messages),
    createdAt: Date.now(),
    sourceMessageId: messages[messages.length - 1]?.id,
    messages: messages.map((entry) => ({ ...entry })),
  };
  return {
    ...tab,
    chatCheckpoints: [checkpoint, ...(tab.chatCheckpoints ?? [])].slice(0, 5),
  };
}

/* ------------------------------------------------------------------ */
/*  handleRestoreLatestCheckpoint                                      */
/* ------------------------------------------------------------------ */

export interface CheckpointRestoreResult {
  newTab: TerminalTab | null;
  activeTabId: string;
}

export function computeCheckpointRestore(
  tabs: TerminalTab[],
  tabId: string,
): CheckpointRestoreResult {
  const sourceTab = tabs.find((tab) => tab.id === tabId && tab.kind === 'chat');
  const checkpoint = sourceTab?.chatCheckpoints?.[0];
  if (!sourceTab || !checkpoint) return { newTab: null, activeTabId: '' };

  const nextTabId = createWorkspaceTabId('chat');
  const now = Date.now();
  const recoveryNote = [
    `Resume from checkpoint "${checkpoint.label}".`,
    'Use this saved transcript point as the last known safe state.',
    'Re-establish the plan from the preserved context before making new edits.',
  ].join('\n\n');
  return {
    newTab: {
      id: nextTabId,
      label: `${sourceTab.label} · checkpoint`,
      kind: 'chat',
      tmuxSession: null,
      chatRuntime: sourceTab.chatRuntime,
      chatSessionKey: undefined,
      chatModel: sourceTab.chatModel,
      chatContinueLatest: false,
      chatDraftInjection: {
        id: `workspace-chat-injection-${Date.now()}`,
        text: recoveryNote,
        reason: 'checkpoint-restore',
        autoSend: false,
      },
      chatCheckpoints: sourceTab.chatCheckpoints,
      repo: sourceTab.repo,
      linkedIssue: sourceTab.linkedIssue ?? null,
      createdAt: now,
      lastActivity: now,
      chatMessages: checkpoint.messages.map((entry) => ({ ...entry })),
    },
    activeTabId: nextTabId,
  };
}

/* ------------------------------------------------------------------ */
/*  archiveWorkspaceTab (side-effect helper)                           */
/* ------------------------------------------------------------------ */

export function archivePacket(packetId: string | null | undefined): void {
  if (!packetId) return;
  const missionState = readOrchestratorMissionState();
  const packet = missionState.packets.find((entry) => entry.id === packetId);
  if (!packet || packet.archivedAt) return;
  void persistOrchestratorMissionState({
    ...missionState,
    packets: missionState.packets.map((entry) => (
      entry.id === packetId ? { ...entry, archivedAt: new Date().toISOString() } : entry
    )),
  });
}

/* ------------------------------------------------------------------ */
/*  handleOpenHistoryChat                                              */
/* ------------------------------------------------------------------ */

export function buildHistoryChatTab(
  currentTab: TerminalTab,
  historyTabId: string,
  title: string,
  historyRepo?: { name?: string; localPath?: string; branch?: string | null; remoteUrl?: string | null } | null,
): TerminalTab {
  const now = Date.now();
  return {
    id: historyTabId,
    label: title.slice(0, 20) + (title.length > 20 ? '...' : ''),
    kind: 'llm-chat',
    tmuxSession: null,
    repo: historyRepo?.localPath || historyRepo?.name
      ? {
          name: historyRepo?.name ?? currentTab.repo?.name ?? 'repo',
          localPath: historyRepo?.localPath ?? currentTab.repo?.localPath ?? '',
          branch: historyRepo?.branch ?? currentTab.repo?.branch ?? null,
          remoteUrl: historyRepo?.remoteUrl ?? currentTab.repo?.remoteUrl,
        }
      : currentTab.repo,
    linkedIssue: currentTab.linkedIssue ?? null,
    createdAt: now,
    lastActivity: now,
  };
}

/* ------------------------------------------------------------------ */
/*  handleRunCommandInTerminal                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  serializeTabsForPersistence                                        */
/* ------------------------------------------------------------------ */

export function serializeTabsForPersistence(currentTabs: TerminalTab[]) {
  return currentTabs
    .filter((tab) => !(tab.kind === 'canvas' && tab.canvasTab?.kind === 'ci'))
    .map((tab) => ({
      id: tab.id,
      label: tab.label,
      kind: tab.kind,
      cliAgent: tab.cliAgent ?? 'shell',
      repoName: tab.repo?.name,
      repoPath: tab.repo?.localPath,
      tmuxSession: tab.tmuxSession ?? undefined,
      chatRuntime: tab.chatRuntime,
      chatSessionKey: tab.chatSessionKey,
      chatModel: tab.chatModel,
      chatContinueLatest: tab.chatContinueLatest,
      chatCheckpoints: tab.chatCheckpoints,
      linkedIssue: tab.linkedIssue ?? undefined,
      orchestrationPacket: tab.orchestrationPacket ?? undefined,
      supervisorStatus: tab.supervisorStatus ?? undefined,
      autoArchiveOnIdle: tab.autoArchiveOnIdle ?? undefined,
      canvasTab: tab.canvasTab ? {
        id: tab.canvasTab.id,
        kind: tab.canvasTab.kind,
        label: tab.canvasTab.label,
        resourceId: tab.canvasTab.resourceId,
        meta: tab.canvasTab.meta,
      } : undefined,
    }));
}

export function buildPersistedState(
  currentTabs: TerminalTab[],
  currentActiveId: string,
): PersistedTabState {
  const persistableTabs = serializeTabsForPersistence(currentTabs);
  const nextActiveId = persistableTabs.length === 0
    ? ''
    : persistableTabs.some((tab) => tab.id === currentActiveId)
      ? currentActiveId
      : (persistableTabs[persistableTabs.length - 1]?.id ?? '');
  return {
    version: 1,
    activeTabId: nextActiveId,
    tabs: persistableTabs,
    savedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/*  handleRunCommandInTerminal                                         */
/* ------------------------------------------------------------------ */

export interface RunCommandResult {
  kind: 'existing-shell' | 'pending-shell' | 'new-tab';
  tmuxSession?: string;
  pendingTabId?: string;
  newTab?: TerminalTab;
}

export function resolveRunCommandTarget(tabs: TerminalTab[]): RunCommandResult {
  const shellTab = tabs.find((tab) => tab.kind === 'terminal' && tab.tmuxSession);
  if (shellTab?.tmuxSession) {
    return { kind: 'existing-shell', tmuxSession: shellTab.tmuxSession };
  }
  const pendingShell = tabs.find((tab) => tab.kind === 'terminal' && !tab.tmuxSession);
  if (pendingShell) {
    return { kind: 'pending-shell', pendingTabId: pendingShell.id };
  }
  return { kind: 'new-tab', newTab: buildRunCommandTab() };
}

export function buildRunCommandTab(): TerminalTab {
  const nextTabId = createWorkspaceTabId('terminal');
  const now = Date.now();
  return {
    id: nextTabId,
    label: 'Terminal',
    kind: 'terminal',
    tmuxSession: null,
    cliAgent: 'shell',
    createdAt: now,
    lastActivity: now,
  };
}

/* ------------------------------------------------------------------ */
/*  URL detection from terminal output                                 */
/* ------------------------------------------------------------------ */

export function detectLocalhostPreviews(
  data: string,
  sessionName: string,
  tabs: TerminalTab[],
  detectedPorts: Set<number>,
): LocalhostPreview[] {
  const previews: LocalhostPreview[] = [];
  try {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    const clean = new TextDecoder().decode(bytes).replace(ANSI_RE, '');
    LOCALHOST_RE.lastIndex = 0;
    const now = Date.now();
    for (const match of clean.matchAll(LOCALHOST_RE)) {
      const port = parseInt(match[1], 10);
      if (IGNORED_PORTS.has(port) || detectedPorts.has(port)) continue;
      detectedPorts.add(port);
      const tab = tabs.find((entry) => entry.tmuxSession === sessionName);
      let url = match[0].replace('0.0.0.0', 'localhost');
      if (!url.startsWith('http')) url = `http://${url}`;
      previews.push({
        id: `preview-${port}`,
        tabId: tab?.id ?? '',
        url,
        port,
        detectedAt: now,
      });
    }
  } catch {
    // decode error — ignore
  }
  return previews;
}

/* ------------------------------------------------------------------ */
/*  updateChatRuntimeStatus tab updater                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  isAutoArchiveEligible                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  computeCloseTab                                                    */
/* ------------------------------------------------------------------ */

export interface CloseTabResult {
  remaining: TerminalTab[];
  nextActiveId: string | null;
  detachedSession: string | null;
  removedPreviewPorts: number[];
}

export function computeCloseTab(
  tabs: TerminalTab[],
  tabId: string,
  activeTabId: string,
): CloseTabResult | null {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return null;
  const tab = tabs[index];
  const remaining = tabs.filter((entry) => entry.id !== tabId);
  let nextActiveId: string | null = null;
  if (tabId === activeTabId && remaining.length > 0) {
    // Prefer the Orchestrator tab as the fallback so closing a CLI/chat session
    // returns the user to the brain rather than skipping into the Assistant.
    const orchestrator = remaining.find((entry) => entry.kind === 'orchestrator');
    nextActiveId = orchestrator
      ? orchestrator.id
      : remaining[Math.min(index, remaining.length - 1)].id;
  } else if (tabId === activeTabId) {
    nextActiveId = '';
  }
  return {
    remaining,
    nextActiveId,
    detachedSession: tab.tmuxSession,
    removedPreviewPorts: [],
  };
}

/* ------------------------------------------------------------------ */
/*  isAutoArchiveEligible                                              */
/* ------------------------------------------------------------------ */

export function isAutoArchiveEligible(tab: TerminalTab): boolean {
  if (tab.kind !== 'chat' || !tab.autoArchiveOnIdle) return false;
  const laneStatus = resolveWorkspaceChatLaneStatus(tab);
  return laneStatus === 'awaiting_review'
    || laneStatus === 'idle'
    || laneStatus === 'released'
    || tab.supervisorStatus?.trim().toLowerCase() === 'completed'
    || tab.supervisorStatus?.trim().toLowerCase() === 'failed';
}

/* ------------------------------------------------------------------ */
/*  startPreviewDrag                                                   */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  observeXtermHelperNames                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  flushPendingCliCommands                                            */
/* ------------------------------------------------------------------ */

export function flushPendingCliCommands(
  tabs: TerminalTab[],
  pendingCliCommands: Map<string, string>,
  sendTerminalInput: (sessionName: string, data: string) => void,
): void {
  for (const tab of tabs) {
    if (tab.tmuxSession && pendingCliCommands.has(tab.id)) {
      const command = pendingCliCommands.get(tab.id)!;
      pendingCliCommands.delete(tab.id);
      fetch('/api/panel/terminal-exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionName: tab.tmuxSession, command }),
      }).catch(() => {
        setTimeout(() => {
          sendTerminalInput(tab.tmuxSession!, command + '\n');
        }, 2000);
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/*  observeXtermHelperNames                                            */
/* ------------------------------------------------------------------ */

export function observeXtermHelperNames(
  root: HTMLDivElement,
  stateScope: string,
): () => void {
  const syncHelperNames = () => {
    const helperTextareas = Array.from(root.querySelectorAll<HTMLTextAreaElement>('.xterm-helper-textarea'));
    helperTextareas.forEach((textarea, index) => {
      if (!textarea.getAttribute('name')) {
        textarea.setAttribute('name', `workspaceTerminalInput-${stateScope}-${index}`);
      }
    });
  };
  syncHelperNames();
  const observer = new MutationObserver(() => { syncHelperNames(); });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/* ------------------------------------------------------------------ */
/*  startPreviewDrag                                                   */
/* ------------------------------------------------------------------ */

export function startPreviewDrag(
  containerDiv: HTMLDivElement | null,
  setPreviewHeight: (h: number) => void,
  setIsDragging: (d: boolean) => void,
): void {
  setIsDragging(true);
  const onMove = (moveEvent: globalThis.MouseEvent) => {
    if (!containerDiv) return;
    const rect = containerDiv.getBoundingClientRect();
    const ratio = (moveEvent.clientY - rect.top) / rect.height;
    setPreviewHeight(Math.min(0.8, Math.max(0.2, ratio)));
  };
  const onUp = () => {
    setIsDragging(false);
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  document.body.style.cursor = 'row-resize';
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

/* ------------------------------------------------------------------ */
/*  updateChatRuntimeStatus tab updater                                */
/* ------------------------------------------------------------------ */

export function computeChatRuntimeStatusUpdate(
  tab: TerminalTab,
  normalizedTarget: string,
  status: string,
  label?: string,
): { updated: TerminalTab; found: boolean } {
  if (tab.kind !== 'chat') return { updated: tab, found: false };
  const currentSessionKey = normalizeWorkspaceChatSessionKey(tab.chatRuntime, tab.chatSessionKey);
  if (!currentSessionKey || currentSessionKey !== normalizedTarget) return { updated: tab, found: false };
  const nextStatus = status.trim();
  const statusChanged = (tab.supervisorStatus ?? '') !== nextStatus;
  const nextPacketStatus = packetStatusFromSupervisorStatus(nextStatus, tab.orchestrationPacket?.status ?? null);
  const packetChanged = nextPacketStatus !== (tab.orchestrationPacket?.status ?? null);
  return {
    updated: {
      ...tab,
      label: label ?? tab.label,
      supervisorStatus: nextStatus,
      autoArchiveOnIdle: tab.autoArchiveOnIdle ?? true,
      orchestrationPacket: tab.orchestrationPacket
        ? { ...tab.orchestrationPacket, status: nextPacketStatus ?? tab.orchestrationPacket.status }
        : tab.orchestrationPacket,
      lastActivity: statusChanged || packetChanged ? Date.now() : tab.lastActivity,
    },
    found: true,
  };
}
