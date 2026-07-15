import {
  adHocLaneTitle,
  laneDisplayTitle,
} from '@/lib/orchestrator/display';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import { CLAUDE_CLI_MODELS, CODEX_CLI_MODELS, GEMINI_CLI_MODELS, getOpenCodeModels } from '@/components/desktop/workspace-terminal/constants';
import type {
  OrchestratorLaneSnapshot,
} from '@/lib/orchestrator/types';
import type {
  RegisteredRepo,
  TerminalTab,
  TerminalTabHandle,
  WorkspaceChatRuntime,
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

function cleanRuntimeSessionLabel(label?: string | null): string | null {
  const cleaned = label?.replace(/^\[automation\]\s*/i, '').trim();
  return cleaned || null;
}

function sameRepoPath(left?: RegisteredRepo, right?: RegisteredRepo) {
  return !right || left?.localPath === right.localPath;
}

function isOrphanSessionLabelMatch(
  tab: TerminalTab,
  options: Parameters<TerminalTabHandle['openCliChatSession']>[0],
  resolvedRuntime: Exclude<WorkspaceChatRuntime, 'chat'>,
) {
  if (tab.kind !== 'chat') return false;
  if (tab.chatRuntime !== resolvedRuntime) return false;
  if (tab.chatSessionKey?.trim()) return false;
  if (!sameRepoPath(tab.repo, options.repo)) return false;
  const targetLabel = cleanRuntimeSessionLabel(options.label ?? options.orchestrationPacket?.title);
  if (!targetLabel) return false;
  return cleanRuntimeSessionLabel(tab.label) === targetLabel;
}

/* ------------------------------------------------------------------ */
/*  openWorkspaceCliChatSession                                        */
/* ------------------------------------------------------------------ */

export interface CliChatSessionResult {
  tabs: TerminalTab[];
  activeTabId: string;
  needsPersist: boolean;
}

function findSupervisorRetryExistingTab(
  currentTabs: TerminalTab[],
  options: Parameters<TerminalTabHandle['openCliChatSession']>[0],
  resolvedRuntime: Exclude<WorkspaceChatRuntime, 'chat'>,
  normalizedTargetSessionKey: string | null,
): TerminalTab | null {
  if (!options.createNew || !options.targetSessionKey || options.initialText) return null;
  if ((options.supervisorStatus ?? '').trim().toLowerCase() !== 'launched') return null;
  const targetLabel = options.label?.trim();
  if (!targetLabel) return null;

  const candidates = currentTabs.filter((tab) => {
    if (tab.kind !== 'chat' || tab.chatRuntime !== resolvedRuntime) return false;
    if ((tab.supervisorStatus ?? '').trim().toLowerCase() !== 'retrying') return false;
    if (tab.label.trim() !== targetLabel) return false;
    if (options.repo && tab.repo?.localPath !== options.repo.localPath) return false;
    return normalizeWorkspaceChatSessionKey(tab.chatRuntime, tab.chatSessionKey) !== normalizedTargetSessionKey;
  });

  return candidates.length === 1 ? candidates[0] : null;
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
      : options.targetSessionKey?.startsWith('gemini-owned:')
        ? 'gemini'
        : options.targetSessionKey?.startsWith('opencode-owned:')
          ? 'opencode'
          : options.targetSessionKey?.startsWith('cursor-owned:')
            ? 'cursor'
            : options.targetSessionKey?.startsWith('grok-owned:')
              ? 'grok'
          : null;
  // When the targetSessionKey carries a definitive runtime prefix, trust it
  // over options.runtime. Prevents wrong-runtime tabs when upstream (e.g.
  // a stale WS mutation) passes runtime='codex' but the actual lane is a
  // gemini-owned / opencode-owned / claude-code session.
  const resolvedRuntime = targetRuntime
    ?? options.runtime
    ?? (isAgentRuntimeTab(currentActiveTab) ? currentActiveTab.chatRuntime : (options.createNew ? 'codex' : 'claude-code'));
  const normalizedTargetSessionKey = options.targetSessionKey
    ? normalizeWorkspaceChatSessionKey(resolvedRuntime, options.targetSessionKey)
    : null;
  const supervisorRetryExisting = findSupervisorRetryExistingTab(
    currentTabs,
    options,
    resolvedRuntime,
    normalizedTargetSessionKey,
  );

  const targetedExisting = options.createNew || !options.targetSessionKey
    ? null
    : currentTabs.find((tab) => (
        tab.kind === 'chat'
        && formatWorkspaceChatSessionKey(tab.chatRuntime, tab.chatSessionKey) === normalizedTargetSessionKey
      ));
  // #543 — Supervisor retries rebind the packet to a fresh sessionKey mid-
  // flight. Matching purely on targetSessionKey would open a new tab for
  // every retry and leave the old one as zombie cruft. When the dispatch
  // carries a packetId, prefer the tab already bound to that packet so
  // retries reuse the same surface — chatSessionKey is updated in the
  // match-and-update block below so subsequent WS routing works correctly.
  const targetedPacketId = options.orchestrationPacket?.packetId ?? null;
  const packetExisting = options.createNew || !targetedPacketId
    ? null
    : currentTabs.find((tab) => (
        tab.kind === 'chat'
        && tab.orchestrationPacket?.packetId === targetedPacketId
        && (options.repo ? tab.repo?.localPath === options.repo.localPath : true)
      ));
  const orphanLabelExisting = options.createNew || !options.targetSessionKey
    ? null
    : currentTabs.find((tab) => isOrphanSessionLabelMatch(tab, options, resolvedRuntime));
  const activeExisting = currentTabs.find((tab) => (
    tab.id === currentActiveTabId
    && tab.kind === 'chat'
    && tab.chatRuntime === resolvedRuntime
    && (options.repo ? tab.repo?.localPath === options.repo.localPath : true)
  ));
  // When a specific targetSessionKey was passed (e.g. clicking a packet/
  // session card), ONLY reuse a tab whose session key matches exactly.
  // Otherwise we'd retarget the currently active tab and the user would
  // never be able to view two running agents side by side. When no target
  // key is given (e.g. "new Codex chat" quick action), fall back to the
  // active chat tab of the same runtime so we don't stack duplicates.
  const matchingExisting = supervisorRetryExisting
    ?? (options.createNew
      ? null
      : packetExisting
        ?? (options.targetSessionKey
          ? targetedExisting ?? orphanLabelExisting ?? null
          : activeExisting
            ?? currentTabs.find((tab) => (
              tab.kind === 'chat'
              && tab.chatRuntime === resolvedRuntime
              && (options.repo ? tab.repo?.localPath === options.repo.localPath : true)
            ))));
  const injection = options.initialText ? {
    id: `workspace-chat-injection-${Date.now()}`,
    text: options.initialText,
    reason: options.draftReason,
    autoSend: options.autoSend,
    previewImageDataUri: options.previewImageDataUri,
  } : undefined;

  if (matchingExisting) {
    const resolvedTabId = matchingExisting.id;
    // Pick a model that matches the resolved runtime when the reused tab
    // previously spoke a different CLI (otherwise GPT-5.4 chip sticks on a
    // gemini tab). Falls back to the caller's explicit modelId.
    // claude-code chat runtime disabled in v0.1.140 (#1047) — CLAUDE_CLI_MODELS
    // is intentionally empty. Fall back to the Codex default model so legacy
    // localStorage tabs with `chatRuntime: 'claude-code'` don't crash on
    // restore; the 410 from /api/claude-code/send surfaces a clear error if
    // the user actually tries to chat. Same pattern as terminal-tab-handlers.ts.
    const fallbackModelForRuntime = resolvedRuntime === 'claude-code'
      ? (CLAUDE_CLI_MODELS[0]?.id ?? CODEX_CLI_MODELS[0].id)
      : resolvedRuntime === 'gemini' ? GEMINI_CLI_MODELS[0].id
      : resolvedRuntime === 'opencode' ? getOpenCodeModels([])[0].id
      : resolvedRuntime === 'cursor' ? 'cli:cursor:default'
      : resolvedRuntime === 'grok' ? 'cli:grok:default'
      : CODEX_CLI_MODELS[0].id;
    const updatedTabs = currentTabs.map((tab) => (
      tab.id === resolvedTabId
        ? {
            ...tab,
            label: cleanRuntimeSessionLabel(options.label ?? options.orchestrationPacket?.title) ?? tab.label,
            chatRuntime: resolvedRuntime,
            chatSessionKey: normalizedTargetSessionKey ?? tab.chatSessionKey,
            chatModel: options.modelId
              ?? (tab.chatRuntime === resolvedRuntime ? tab.chatModel : fallbackModelForRuntime),
            chatContinueLatest: tab.chatContinueLatest ?? false,
            chatDraftInjection: injection ?? tab.chatDraftInjection,
            orchestrationPacket: options.orchestrationPacket ?? tab.orchestrationPacket ?? null,
            supervisorStatus: options.supervisorStatus ?? tab.supervisorStatus ?? null,
            autoArchiveOnIdle: options.autoArchiveOnIdle ?? tab.autoArchiveOnIdle ?? false,
          }
        : tab
    ));
    const nextTabs = normalizedTargetSessionKey
      ? updatedTabs.filter((tab) => (
        tab.id === resolvedTabId
        || tab.kind !== 'chat'
        || (
          formatWorkspaceChatSessionKey(tab.chatRuntime, tab.chatSessionKey) !== normalizedTargetSessionKey
          && !isOrphanSessionLabelMatch(tab, options, resolvedRuntime)
        )
      ))
      : updatedTabs;
    return { tabs: nextTabs, activeTabId: resolvedTabId, needsPersist: true };
  }

  const resolvedTabId = createWorkspaceTabId('chat');
  const now = Date.now();
  const newTab: TerminalTab = {
    id: resolvedTabId,
    label: cleanRuntimeSessionLabel(options.label ?? options.orchestrationPacket?.title) ?? adHocLaneTitle('chat'),
    kind: 'chat',
    tmuxSession: null,
    chatRuntime: resolvedRuntime,
    chatSessionKey: normalizedTargetSessionKey ?? undefined,
    chatModel: options.modelId ?? (
      // claude-code runtime guard — see comment above.
      resolvedRuntime === 'claude-code' ? (CLAUDE_CLI_MODELS[0]?.id ?? CODEX_CLI_MODELS[0].id)
        : resolvedRuntime === 'gemini' ? GEMINI_CLI_MODELS[0].id
        : resolvedRuntime === 'opencode' ? getOpenCodeModels([])[0].id
        : resolvedRuntime === 'cursor' ? 'cli:cursor:default'
        : resolvedRuntime === 'grok' ? 'cli:grok:default'
        : CODEX_CLI_MODELS[0].id
    ),
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
  previewImageDataUri?: string;
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

/**
 * "Empty" llm-chat predicate — a tab the operator could keep typing into
 * without losing anything. Used by `computeLlmChatSession` so that two clicks
 * on "+ New session → Chat" don't pile up two empty Chat tabs side-by-side;
 * the second click just focuses the first one. Mirrors the orchestrator-side
 * `spawnOrchestratorTab` reuse-empty logic.
 */
function isEmptyLlmChatTab(tab: TerminalTab): boolean {
  if (tab.kind !== 'llm-chat') return false;
  if (tab.llmDraftInjection) return false;
  if (tab.chatMessages && tab.chatMessages.length > 0) return false;
  if (tab.orchestrationPacket) return false;
  return true;
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
  // "+ New session → Chat" comes through with `createNew: true`. Before we
  // unconditionally mint a new tab, look for an empty Chat tab the operator
  // already has open — focus it instead of growing a second one.
  const emptyExisting = options.createNew
    ? currentTabs.find((tab) => (
        isEmptyLlmChatTab(tab)
        && (options.repo ? tab.repo?.localPath === options.repo.localPath : true)
      ))
    : null;
  const matchingExisting = emptyExisting
    ?? (options.createNew
      ? null
      : targetedExisting
        ?? activeExisting
        ?? currentTabs.find((tab) => (
          tab.kind === 'llm-chat'
          && (options.repo ? tab.repo?.localPath === options.repo.localPath : true)
        )));
  const injection = options.initialText ? {
    id: `workspace-llm-injection-${Date.now()}`,
    text: options.initialText,
    reason: options.draftReason,
    autoSend: options.autoSend,
    previewImageDataUri: options.previewImageDataUri,
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
      label: options.label ?? 'Chat',
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
    previewImageDataUri: options.previewImageDataUri,
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
