import {
  adHocLaneTitle,
  laneDisplayTitle,
} from '@/lib/orchestrator/display';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import { CLAUDE_CLI_MODELS, CODEX_CLI_MODELS } from '@/components/desktop/workspace-terminal/constants';
import type {
  OrchestratorLaneSnapshot,
} from '@/lib/orchestrator/types';
import type {
  RegisteredRepo,
  TerminalTab,
  TerminalTabHandle,
} from '@/components/desktop/workspace-terminal/types';
import {
  createWorkspaceTabId,
  fallbackWorkspaceChatSessionKey,
  formatWorkspaceChatSessionKey,
  generateLlmChatTabId,
  isAgentRuntimeTab,
  normalizeWorkspaceChatSessionKey,
  repoSlugFromRemote,
  resolveWorkspaceChatLaneStatus,
} from '@/components/desktop/workspace-terminal/utils';

/* ------------------------------------------------------------------ */
/*  openWorkspaceCliChatSession                                        */
/* ------------------------------------------------------------------ */

export interface CliChatSessionResult {
  tabs: TerminalTab[];
  activeTabId: string;
  needsPersist: boolean;
}

export function computeCliChatSession(
  options: Parameters<TerminalTabHandle['openCliChatSession']>[0],
  currentTabs: TerminalTab[],
  currentActiveTabId: string,
): CliChatSessionResult {
  const currentActiveTab = currentTabs.find((tab) => tab.id === currentActiveTabId);
  const targetRuntime = options.targetSessionKey?.startsWith('codex:')
    || options.targetSessionKey?.startsWith('codex-owned:')
    || options.targetSessionKey?.startsWith('codex-discovered:')
    || options.targetSessionKey?.startsWith('codex-live:')
    ? 'codex'
    : options.targetSessionKey?.startsWith('claude-code:')
      ? 'claude-code'
      : null;
  const resolvedRuntime = options.runtime
    ?? targetRuntime
    ?? (isAgentRuntimeTab(currentActiveTab) ? currentActiveTab.chatRuntime : (options.createNew ? 'codex' : 'claude-code'));
  const normalizedTargetSessionKey = options.targetSessionKey
    ? normalizeWorkspaceChatSessionKey(resolvedRuntime, options.targetSessionKey)
    : null;

  const targetedExisting = options.createNew || !options.targetSessionKey
    ? null
    : currentTabs.find((tab) => (
        tab.kind === 'chat'
        && formatWorkspaceChatSessionKey(tab.chatRuntime, tab.chatSessionKey) === normalizedTargetSessionKey
        && (options.repo ? tab.repo?.localPath === options.repo.localPath : true)
      ));
  const activeExisting = currentTabs.find((tab) => (
    tab.id === currentActiveTabId
    && tab.kind === 'chat'
    && tab.chatRuntime === resolvedRuntime
    && (options.repo ? tab.repo?.localPath === options.repo.localPath : true)
  ));
  const matchingExisting = options.createNew
    ? null
    : targetedExisting
      ?? activeExisting
      ?? currentTabs.find((tab) => (
        tab.kind === 'chat'
        && tab.chatRuntime === resolvedRuntime
        && (options.repo ? tab.repo?.localPath === options.repo.localPath : true)
      ));
  const injection = options.initialText ? {
    id: `workspace-chat-injection-${Date.now()}`,
    text: options.initialText,
    reason: options.draftReason,
    autoSend: options.autoSend,
  } : undefined;

  if (matchingExisting) {
    const resolvedTabId = matchingExisting.id;
    const nextTabs = currentTabs.map((tab) => (
      tab.id === resolvedTabId
        ? {
            ...tab,
            label: options.label ?? options.orchestrationPacket?.title ?? tab.label,
            chatSessionKey: normalizedTargetSessionKey ?? tab.chatSessionKey,
            chatModel: options.modelId ?? tab.chatModel,
            chatContinueLatest: tab.chatContinueLatest ?? false,
            chatDraftInjection: injection ?? tab.chatDraftInjection,
            orchestrationPacket: options.orchestrationPacket ?? tab.orchestrationPacket ?? null,
            supervisorStatus: options.supervisorStatus ?? tab.supervisorStatus ?? null,
            autoArchiveOnIdle: options.autoArchiveOnIdle ?? tab.autoArchiveOnIdle ?? false,
          }
        : tab
    ));
    return { tabs: nextTabs, activeTabId: resolvedTabId, needsPersist: true };
  }

  const resolvedTabId = createWorkspaceTabId('chat');
  const now = Date.now();
  const newTab: TerminalTab = {
    id: resolvedTabId,
    label: options.label ?? options.orchestrationPacket?.title ?? adHocLaneTitle('chat'),
    kind: 'chat',
    tmuxSession: null,
    chatRuntime: resolvedRuntime,
    chatSessionKey: normalizedTargetSessionKey ?? undefined,
    chatModel: options.modelId ?? (resolvedRuntime === 'claude-code' ? CLAUDE_CLI_MODELS[0].id : CODEX_CLI_MODELS[0].id),
    chatContinueLatest: false,
    chatDraftInjection: injection,
    chatCheckpoints: [],
    repo: options.repo,
    orchestrationPacket: options.orchestrationPacket ?? null,
    supervisorStatus: options.supervisorStatus ?? null,
    autoArchiveOnIdle: options.autoArchiveOnIdle ?? false,
    createdAt: now,
    lastActivity: now,
    chatMessages: [],
  };
  return { tabs: [...currentTabs, newTab], activeTabId: resolvedTabId, needsPersist: true };
}

/* ------------------------------------------------------------------ */
/*  openWorkspaceLlmChatSession                                        */
/* ------------------------------------------------------------------ */

export interface LlmChatSessionOptions {
  repo?: RegisteredRepo;
  initialText?: string;
  draftReason?: string;
  autoSend?: boolean;
  createNew?: boolean;
  label?: string;
  targetSessionKey?: string;
}

export interface LlmChatSessionResult {
  /** If non-null, apply this tab update via setTabs(updater) */
  updatedTabId: string | null;
  /** If non-null, append this new tab */
  newTab: TerminalTab | null;
  activeTabId: string;
}

export function computeLlmChatSession(
  options: LlmChatSessionOptions,
  currentTabs: TerminalTab[],
  currentActiveTabId: string,
): LlmChatSessionResult {
  const targetTabId = options.targetSessionKey?.startsWith('llm-chat:')
    ? options.targetSessionKey.slice('llm-chat:'.length)
    : null;
  const activeExisting = currentTabs.find((tab) => (
    tab.id === currentActiveTabId
    && tab.kind === 'llm-chat'
    && (options.repo ? tab.repo?.localPath === options.repo.localPath : true)
  ));
  const targetedExisting = options.createNew || !targetTabId
    ? null
    : currentTabs.find((tab) => (
        tab.kind === 'llm-chat'
        && tab.id === targetTabId
        && (options.repo ? tab.repo?.localPath === options.repo.localPath : true)
      ));
  const matchingExisting = options.createNew
    ? null
    : targetedExisting
      ?? activeExisting
      ?? currentTabs.find((tab) => (
        tab.kind === 'llm-chat'
        && (options.repo ? tab.repo?.localPath === options.repo.localPath : true)
      ));
  const injection = options.initialText ? {
    id: `workspace-llm-injection-${Date.now()}`,
    text: options.initialText,
    reason: options.draftReason,
    autoSend: options.autoSend,
  } : undefined;

  if (matchingExisting) {
    return {
      updatedTabId: matchingExisting.id,
      newTab: null,
      activeTabId: matchingExisting.id,
    };
  }

  const resolvedTabId = generateLlmChatTabId();
  const now = Date.now();
  return {
    updatedTabId: null,
    newTab: {
      id: resolvedTabId,
      label: options.label ?? 'Assistant',
      kind: 'llm-chat',
      tmuxSession: null,
      repo: options.repo,
      linkedIssue: null,
      llmDraftInjection: injection,
      createdAt: now,
      lastActivity: now,
    },
    activeTabId: resolvedTabId,
  };
}

/* We need to expose the injection builder for the matching-existing case */
export function buildLlmInjection(options: LlmChatSessionOptions) {
  return options.initialText ? {
    id: `workspace-llm-injection-${Date.now()}`,
    text: options.initialText,
    reason: options.draftReason,
    autoSend: options.autoSend,
  } : undefined;
}

/* ------------------------------------------------------------------ */
/*  openWorkspaceInspectorTab                                          */
/* ------------------------------------------------------------------ */

export interface InspectorTabResult {
  /** If non-null, update this existing tab */
  updatedTabId: string | null;
  /** If non-null, append this new tab */
  newTab: TerminalTab | null;
  /** The tab ID to activate (null = don't change active) */
  activeTabId: string | null;
}

export function computeInspectorTab(
  canvasTab: NonNullable<TerminalTab['canvasTab']>,
  currentTabs: TerminalTab[],
  options?: { repo?: RegisteredRepo; createNew?: boolean },
): InspectorTabResult {
  const backgroundLoad = canvasTab.kind === 'pr' || canvasTab.kind === 'issue';
  const matchingExisting = options?.createNew
    ? null
    : currentTabs.find((tab) => (
        tab.kind === 'canvas'
        && tab.canvasTab?.id === canvasTab.id
        && (options?.repo ? tab.repo?.localPath === options.repo.localPath : true)
      ));

  if (matchingExisting) {
    return {
      updatedTabId: matchingExisting.id,
      newTab: null,
      activeTabId: backgroundLoad ? null : matchingExisting.id,
    };
  }

  const resolvedTabId = createWorkspaceTabId('canvas');
  const now = Date.now();
  return {
    updatedTabId: null,
    newTab: {
      id: resolvedTabId,
      label: canvasTab.label,
      kind: 'canvas',
      tmuxSession: null,
      repo: options?.repo,
      canvasTab,
      unseen: backgroundLoad,
      createdAt: now,
      lastActivity: now,
    },
    activeTabId: backgroundLoad ? null : resolvedTabId,
  };
}

/* ------------------------------------------------------------------ */
/*  handleOpenWorkspaceCommitTab                                       */
/* ------------------------------------------------------------------ */

export function buildCommitCanvasTab(
  hash: string,
  meta?: Record<string, string>,
  repo?: RegisteredRepo,
): { canvasTab: NonNullable<TerminalTab['canvasTab']>; repo?: RegisteredRepo } {
  const nextMeta: Record<string, string> = { ...(meta ?? {}) };
  if (!nextMeta.workspace && repo?.localPath) {
    nextMeta.workspace = repo.localPath;
  }
  const repoSlug = repoSlugFromRemote(repo?.remoteUrl);
  if (!nextMeta.repo && repoSlug) {
    nextMeta.repo = repoSlug;
  }
  return {
    canvasTab: {
      id: `commit:${hash}:${nextMeta.workspace ?? 'default'}`,
      kind: 'commit',
      label: hash.slice(0, 7),
      resourceId: hash,
      meta: Object.keys(nextMeta).length > 0 ? nextMeta : undefined,
    },
    repo,
  };
}

/* ------------------------------------------------------------------ */
/*  buildChatSessionSnapshots (for mobile inbox reporting)             */
/* ------------------------------------------------------------------ */

export function buildChatSessionSnapshots(
  visibleTabs: TerminalTab[],
  effectiveActiveTabId: string,
  preferredLocalPath: string,
  preferredBranch: string,
  stableRepoScope: string | null,
  stateScope: string,
): MobileInboxSnapshot['sessions'] {
  return visibleTabs
    .filter(isAgentRuntimeTab)
    .map((tab) => {
      const runtime = tab.chatRuntime;
      const prefixedKey = normalizeWorkspaceChatSessionKey(runtime, tab.chatSessionKey)
        ?? fallbackWorkspaceChatSessionKey(runtime, tab.id, stableRepoScope ?? stateScope);
      const repoSlug = repoSlugFromRemote(tab.repo?.remoteUrl);
      const latestMessage = [...(tab.chatMessages ?? [])].reverse().find((entry) => entry.role === 'assistant' || entry.role === 'user');
      const hasLiveSession = Boolean(normalizeWorkspaceChatSessionKey(runtime, tab.chatSessionKey));
      const laneTitle = laneDisplayTitle(tab.orchestrationPacket, tab.kind);
      const laneStatus = resolveWorkspaceChatLaneStatus(tab);
      return {
        id: prefixedKey,
        name: laneTitle,
        squadId: 'workspace',
        runtime,
        model: tab.chatModel ?? (runtime === 'claude-code' ? 'claude-code' : 'codex'),
        status: laneStatus === 'blocked'
          ? 'blocked'
          : laneStatus === 'launching'
            ? 'waiting'
            : tab.id === effectiveActiveTabId && hasLiveSession
              ? 'running'
              : hasLiveSession
                ? 'reviewing'
                : 'idle',
        currentTask: tab.orchestrationPacket?.title ?? latestMessage?.text?.trim() ?? (hasLiveSession ? '' : 'Idle'),
        workspace: tab.repo?.localPath ?? preferredLocalPath,
        branch: tab.repo?.branch ?? preferredBranch,
        sessionKey: prefixedKey,
        approvalStatus: 'none' as const,
        lastEventAt: new Date(tab.lastActivity).toISOString(),
        context: { usedPercent: 0, trend: 'stable' as const },
        alerts: 0,
        surfaceLabel: laneTitle,
        isCurrentSession: tab.id === effectiveActiveTabId,
        orchestrationPacket: tab.orchestrationPacket ?? null,
        runtimeSurface: {
          id: prefixedKey,
          runtime,
          kind: 'chat-session' as const,
          ownership: 'owned' as const,
          title: laneTitle,
          cwd: tab.repo?.localPath ?? preferredLocalPath,
          branch: tab.repo?.branch ?? preferredBranch,
          sourceLabel: hasLiveSession
            ? 'Workspace lane'
            : tab.supervisorStatus
              ? `Workspace lane (${tab.supervisorStatus})`
              : 'Workspace lane restored without a live runtime session',
          capabilities: {
            attach: false,
            readTail: true,
            sendInput: hasLiveSession,
            interrupt: hasLiveSession,
            resize: false,
            diffContext: true,
            reviewContext: true,
          },
          reviewContext: repoSlug ? {
            repoSlug,
            branch: tab.repo?.branch ?? preferredBranch,
          } : undefined,
        },
      };
    });
}

/* ------------------------------------------------------------------ */
/*  getChatTabSnapshots (for orchestrator lane inventory)               */
/* ------------------------------------------------------------------ */

export function buildOrchestratorLaneSnapshots(
  tabs: TerminalTab[],
  tileId: string,
  preferredRepoPath: string | null,
  preferredBranch: string | null,
): OrchestratorLaneSnapshot[] {
  return tabs
    .filter(isAgentRuntimeTab)
    .map((tab) => ({
      tileId,
      tabId: tab.id,
      label: tab.label,
      runtime: tab.chatRuntime,
      sessionKey: normalizeWorkspaceChatSessionKey(tab.chatRuntime, tab.chatSessionKey),
      repoPath: tab.repo?.localPath ?? preferredRepoPath,
      branch: tab.repo?.branch ?? preferredBranch,
      status: resolveWorkspaceChatLaneStatus(tab) === 'running' ? 'running' as const : 'idle' as const,
      lastActivityAt: new Date(tab.lastActivity).toISOString(),
      packetId: tab.orchestrationPacket?.packetId ?? null,
    }));
}

/* ------------------------------------------------------------------ */
/*  computeChatSessionSignature                                        */
/* ------------------------------------------------------------------ */

export function computeChatSessionSignature(
  sessions: MobileInboxSnapshot['sessions'],
): string {
  return JSON.stringify(sessions.map((session) => ({
    sessionKey: session.sessionKey,
    status: session.status,
    name: session.name,
    currentTask: session.currentTask,
    workspace: session.workspace,
    branch: session.branch,
    lastEventAt: session.lastEventAt,
  })));
}

export function resolveActiveChatSessionKey(
  sessions: MobileInboxSnapshot['sessions'],
  previousActiveKey: string | null,
): string | null {
  const activeChat = sessions.find((s) => s.isCurrentSession)
    ?? sessions.find((s) => s.sessionKey === previousActiveKey)
    ?? sessions[0]
    ?? null;
  return activeChat?.sessionKey ?? null;
}
