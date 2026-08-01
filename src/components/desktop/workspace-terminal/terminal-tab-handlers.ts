import { stripPersistedTabs, type PersistedChatCheckpoint, type PersistedTabState } from '@/lib/terminal/tab-state';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { retainTranscriptEntries } from '@/lib/transcripts/store';
import {
  adHocLaneTitle,
} from '@/lib/orchestrator/display';
import {
  persistOrchestratorMissionState,
  readOrchestratorMissionState,
} from '@/lib/orchestrator/store';
import { ANSI_RE, CLAUDE_CLI_MODELS, CODEX_CLI_MODELS, GEMINI_CLI_MODELS, getOpenCodeModels, CLI_AGENTS, IGNORED_PORTS, LOCALHOST_RE } from '@/components/desktop/workspace-terminal/constants';
import type {
  LocalhostPreview,
  RegisteredRepo,
  TerminalTab,
  WorkspaceChatRuntime,
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

/**
 * Issue #708 — pick the lowest unused `Terminal N` number among existing
 * shell terminal tabs. Only labels matching `Terminal <integer>` participate;
 * agent-named terminals (Claude Code, Codex, etc.) keep their own labels.
 */
/**
 * Single-quote a shell argument to prevent injection via paths with spaces or
 * special characters (e.g. `cd /some/path with spaces` → `cd '/some/path with spaces'`).
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function nextTerminalLabel(tabs: TerminalTab[]): string {
  const used = new Set<number>();
  for (const tab of tabs) {
    if (tab.kind !== 'terminal') continue;
    const match = /^Terminal\s+(\d+)$/.exec(tab.label?.trim() ?? '');
    if (match) used.add(Number(match[1]));
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return `Terminal ${n}`;
}

export function computeNewTerminalTab(
  agentId: string,
  repo?: RegisteredRepo,
  currentTabs: TerminalTab[] = [],
): NewTerminalTabResult {
  const agent = CLI_AGENTS.find((candidate) => candidate.id === agentId);
  if (!agent) return { newTab: null, activeTabId: '', cliCommand: null };

  const tabId = createWorkspaceTabId('terminal');
  const now = Date.now();
  // Generic shell terminals get unique `Terminal N` labels; agent CLIs
  // (Claude Code, Codex, OpenCode, Gemini CLI) keep their named labels so
  // the user can tell at a glance which CLI is loaded.
  const label = agentId === 'shell' ? nextTerminalLabel(currentTabs) : agent.label;
  const newTab: TerminalTab = {
    id: tabId,
    label,
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
    if (repo) parts.push(`cd ${shellQuote(repo.localPath)}`);
    if (agent.command) parts.push(agent.command);
    cliCommand = parts.join(' && ');
  }

  return { newTab, activeTabId: tabId, cliCommand };
}

/* ------------------------------------------------------------------ */
/*  handleNewChatTab                                                   */
/* ------------------------------------------------------------------ */

export function buildNewChatTab(
  runtime: Exclude<WorkspaceChatRuntime, 'chat'>,
  repo?: RegisteredRepo,
): TerminalTab {
  const tabId = createWorkspaceTabId('chat');
  const now = Date.now();
  // claude-code chat runtime disabled in v0.1.140 (#1047). The list is
  // empty, so we fall back to the codex default model — if anyone managed
  // to construct a `claude-code` chat tab via legacy localStorage, the
  // 410 from /api/claude-code/send surfaces a clear error in chat.
  const defaultModel = runtime === 'claude-code'
    ? (CLAUDE_CLI_MODELS[0]?.id ?? CODEX_CLI_MODELS[0].id)
    : runtime === 'gemini'
      ? GEMINI_CLI_MODELS[0].id
      : runtime === 'opencode'
        ? getOpenCodeModels([])[0].id
        : runtime === 'cursor'
          ? 'cli:cursor:default'
          : runtime === 'grok'
            ? 'cli:grok:default'
        : CODEX_CLI_MODELS[0].id;
  return {
    id: tabId,
    label: adHocLaneTitle('chat'),
    kind: 'chat',
    tmuxSession: null,
    chatRuntime: runtime,
    chatContinueLatest: false,
    chatModel: defaultModel,
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
    label: 'Chat',
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
  const retainedMessages = retainTranscriptEntries(messages);
  const previousMessages = tab.chatMessages ?? [];
  if (sameTranscriptMessages(previousMessages, retainedMessages)) {
    return previousMessages === retainedMessages ? tab : { ...tab, chatMessages: retainedMessages };
  }
  const latestTimestamp = retainedMessages.reduce((max, entry) => Math.max(max, entry.timestamp ?? 0), 0);
  return {
    ...tab,
    chatMessages: retainedMessages,
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
  const normalizedSessionKey = tab.chatRuntime
    ? (normalizeWorkspaceChatSessionKey(tab.chatRuntime, sessionKey) ?? sessionKey)
    : sessionKey;
  const claudeSessionId = tab.chatRuntime === 'claude-code'
    ? (normalizedSessionKey.startsWith('claude-code:')
      ? normalizedSessionKey.slice('claude-code:'.length)
      : normalizedSessionKey)
    : undefined;
  return {
    ...tab,
    chatSessionKey: normalizedSessionKey,
    claudeSessionId: claudeSessionId
      ?? (tab.chatRuntime === 'claude-code' ? tab.claudeSessionId : undefined),
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
  // Orchestrator threads are stored with a `thoughts-` id; reopen them as an
  // orchestrator tab (Claude backend) rather than the free o8-Default casual
  // chat. Anything else stays an llm-chat tab. (See #1100 + the thread-id bridge
  // in OrchestratorTab.)
  const isOrchestratorThread = historyTabId.startsWith('thoughts-');
  return {
    id: historyTabId,
    label: title,
    kind: isOrchestratorThread ? 'orchestrator' : 'llm-chat',
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
  // Issue #714 / #717 — strip zombies before they hit disk:
  //   - canvas:ci tabs (legacy, never persisted)
  //   - orchestrator-prefixed tabs whose `kind` was mutated away from
  //     'orchestrator' (the disk artifact that triggered #714). The canonical
  //     `stripPersistedTabs` helper lives in `@/lib/terminal/tab-state` and is
  //     applied at every layer (server GET/POST, client load/save, in-memory)
  //     so zombies can never sneak through any path.
  const withoutCanvasCi = currentTabs.filter((tab) => !(tab.kind === 'canvas' && tab.canvasTab?.kind === 'ci'));
  return stripPersistedTabs(withoutCanvasCi)
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
      laneId: tab.laneId ?? undefined,
      claudeSessionId: tab.claudeSessionId,
      chatModel: tab.chatModel,
      chatContinueLatest: tab.chatContinueLatest,
      chatCheckpoints: tab.chatCheckpoints,
      linkedIssue: tab.linkedIssue ?? undefined,
      orchestrationPacket: tab.orchestrationPacket ?? undefined,
      supervisorStatus: tab.supervisorStatus ?? undefined,
      autoArchiveOnIdle: tab.autoArchiveOnIdle ?? undefined,
      // #F4 (2026-05-23 dogfood) — orchestrator-kind tabs need their sticky
      // mode + per-mode fields persisted so a reload doesn't collapse them
      // into Chat. The restore heuristic in terminal-restore.ts reads `mode`
      // (with `kind`) to decide whether to rehydrate as orchestrator or
      // llm-chat; missing `mode` was forcing the wrong branch.
      mode: tab.mode,
      singleRuntime: tab.singleRuntime,
      chatModelId: tab.chatModelId,
      chatOpenrouterModel: tab.chatOpenrouterModel,
      orchestratorThreadId: tab.orchestratorThreadId,
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
  return { kind: 'new-tab', newTab: buildRunCommandTab(tabs) };
}

export function buildRunCommandTab(currentTabs: TerminalTab[] = []): TerminalTab {
  const nextTabId = createWorkspaceTabId('terminal');
  const now = Date.now();
  return {
    id: nextTabId,
    label: nextTerminalLabel(currentTabs),
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

function isFinishedWorkspaceChatStatus(tab: TerminalTab): boolean {
  const laneStatus = resolveWorkspaceChatLaneStatus(tab);
  const supervisorStatus = tab.supervisorStatus?.trim().toLowerCase();
  return laneStatus === 'awaiting_review'
    || laneStatus === 'idle'
    || laneStatus === 'released'
    || supervisorStatus === 'completed'
    || supervisorStatus === 'failed';
}

export function isAutoArchiveEligible(tab: TerminalTab): boolean {
  if (tab.kind !== 'chat' || !tab.autoArchiveOnIdle) return false;
  return isFinishedWorkspaceChatStatus(tab);
}

export function isTabFinishedForCleanup(tab: TerminalTab): boolean {
  if (tab.kind !== 'chat') return false;
  return isFinishedWorkspaceChatStatus(tab);
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
