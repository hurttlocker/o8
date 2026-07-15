import {
  adHocLaneTitle,
  laneDisplayTitle,
  orchestratorRuntimeTone,
  orchestratorStatusTone,
} from '@/lib/orchestrator/display';
import type {
  WorkspaceLaneState,
  WorkspaceOrchestrationPacketBadge,
} from '@/lib/orchestrator/types';
import type {
  MobileTranscriptEntry,
  MobileTranscriptThinkingStep,
  MobileTranscriptToolCall,
} from '@/lib/mobile/types';
import { deriveWorkflowStage } from '@/lib/workflows/status';
import { CLI_AGENTS } from '@/components/desktop/workspace-terminal/constants';
import type {
  QueuedContextCard,
  RegisteredRepo,
  TerminalTab,
  WorkspaceChatRuntime,
} from '@/components/desktop/workspace-terminal/types';

export function isAgentRuntimeTab(
  tab: TerminalTab | null | undefined,
): tab is TerminalTab & { kind: 'chat'; chatRuntime: 'codex' | 'claude-code' | 'gemini' | 'antigravity' | 'opencode' | 'cursor' | 'grok' | 'pi' } {
  return tab?.kind === 'chat'
    && (
      tab.chatRuntime === 'codex'
      || tab.chatRuntime === 'claude-code'
      || tab.chatRuntime === 'gemini'
      || tab.chatRuntime === 'opencode'
      || tab.chatRuntime === 'cursor'
      || tab.chatRuntime === 'grok'
    );
}

/**
 * Fix 1 — focused-lane-aware repo default for newly-spawned orchestrator tabs.
 * When the operator opens a "+ New session" orchestrator while a worker-lane
 * tab (any non-orchestrator center tile bound to a repo) is the focused one,
 * the new orchestrator should adopt THAT lane's repo instead of the stale
 * global pick. Returns the focused tab's repo, or null when the focused tab is
 * an orchestrator / repo-less — in which case callers fall back to the global
 * preferredRepo and behavior is unchanged.
 */
export function deriveFocusedLaneRepo(
  tabs: TerminalTab[],
  activeTabId: string,
): RegisteredRepo | null {
  const active = tabs.find((tab) => tab.id === activeTabId);
  if (active && active.kind !== 'orchestrator' && active.repo?.localPath) {
    return active.repo;
  }
  return null;
}

/** Resolve the implicit repo for a newly-created orchestrator session. The
 *  operator's Projects/sidebar selection is the active intent; a focused
 *  worker lane remains the fallback when no project is selected, followed by
 *  the workspace tile's persisted repo scope. */
export function deriveNewOrchestratorRepo(
  tabs: TerminalTab[],
  activeTabId: string,
  selectedRepo: RegisteredRepo | null,
  preferredRepo: RegisteredRepo | null,
): RegisteredRepo | null {
  return selectedRepo
    ?? deriveFocusedLaneRepo(tabs, activeTabId)
    ?? preferredRepo;
}

/**
 * "+ New session → Orchestrator" reuse gate: a tab only counts as a blank
 * spawn when NOTHING has bound to it — no packet, no draft, and crucially no
 * orchestrator thread. Orchestrator transcripts live server-side by thread id
 * (tab.chatMessages stays empty forever), so an empty-messages check alone
 * matched USED tabs and every new-session click merely refocused the old
 * conversation — "new session button does nothing / opens the old
 * orchestrator" (report D3YPBP, Q repro 2026-07-14).
 */
export function isReusableBlankOrchestratorTab(tab: TerminalTab): boolean {
  return (
    tab.kind === 'orchestrator'
    && tab.freshSpawn === true
    && !tab.orchestrationPacket
    && !tab.chatDraftInjection
    && !tab.orchestratorThreadId
    && (!tab.chatMessages || tab.chatMessages.length === 0)
  );
}

/**
 * OrchestratorTab → controller/dashboard bridge: "this tab is bound to thread
 * X". The controller stamps it onto the tab record (tab.orchestratorThreadId),
 * which is what the reuse gate above and per-tab thread persistence key on.
 */
export const WORKSPACE_THREAD_ID_EVENT = 'o8:workspace-thread-id';

/**
 * Publish a tab⇄thread binding. Called from TWO places in OrchestratorTab:
 * the chrome effect (after a thread load LANDS) and the restore claim (the
 * moment a tab COMMITS to restoring the global last-active thread).
 *
 * The claim-time call is the durable half of report D3YPBP round 2
 * (2026-07-15): if the restore's history fetch fails silently (server boot
 * race — worst on slow Rosetta/Apple Silicon boots), a tab stamped only
 * after the load lands stays invisible to the reuse gate, and every
 * "+ New session" click reuses the broken half-restored tab instead of
 * spawning fresh. Stamping the INTENT makes the gate exclude it no matter
 * what the fetch does.
 */
export function publishWorkspaceThreadBinding(tabId: string, threadId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(WORKSPACE_THREAD_ID_EVENT, {
    detail: { tabId, threadId },
  }));
}

export function shortenPath(value: string) {
  const userPath = value.replace(/^\/Users\/[^/]+/, '~');
  if (userPath !== value) return userPath;
  return value.replace(/^\/home\/[^/]+/, '~');
}

export function repoSlugFromRemote(remoteUrl?: string | null) {
  if (!remoteUrl) return null;
  const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  return match?.[1] ?? null;
}

export function activeManualLaneStatus(tab: TerminalTab | null) {
  if (!tab) return orchestratorStatusTone('idle');
  if (tab.kind === 'chat') {
    return orchestratorStatusTone(resolveWorkspaceChatLaneStatus(tab));
  }
  if (tab.kind === 'terminal') {
    return orchestratorStatusTone(tab.tmuxSession ? 'running' : 'launching');
  }
  return orchestratorStatusTone('idle');
}

export function manualLaneRuntimeTone(tab: TerminalTab | null) {
  if (!tab) return null;
  if (tab.kind === 'chat') {
    return orchestratorRuntimeTone(tab.chatRuntime);
  }
  if (tab.kind === 'terminal') {
    if (tab.cliAgent === 'claude') return orchestratorRuntimeTone('claude-code');
    if (tab.cliAgent === 'codex') return orchestratorRuntimeTone('codex');
    const agent = CLI_AGENTS.find((candidate) => candidate.id === tab.cliAgent);
    return {
      label: agent?.label ?? 'Terminal',
      shortLabel: agent?.label?.slice(0, 2) ?? 'Sh',
      color: agent?.color ?? '#64748b',
      background: `${agent?.color ?? '#94a3b8'}1f`,
      border: `${agent?.color ?? '#94a3b8'}33`,
      dot: agent?.color ?? '#94a3b8',
    };
  }
  return null;
}

export function buildWorkspaceLaneState(
  stateScope: string,
  tab: TerminalTab | null,
  preferredRepo?: RegisteredRepo | null,
): WorkspaceLaneState | null {
  if (!tab) {
    return {
      tileId: stateScope,
      tabId: null,
      kind: null,
      title: 'No lane selected',
      subtitle: null,
      repoPath: preferredRepo?.localPath ?? null,
      branch: preferredRepo?.branch ?? null,
      runtime: null,
      sessionKey: null,
      packet: null,
      status: null,
      transcriptState: 'no_lane' as const,
      isAdHoc: true,
    };
  }

  if (tab.kind !== 'chat') {
    return {
      tileId: stateScope,
      tabId: tab.id,
      kind: tab.kind,
      title: laneDisplayTitle(tab.orchestrationPacket, tab.kind),
      subtitle: tab.repo ? `${tab.repo.name} · ${tab.repo.branch ?? 'main'}` : null,
      repoPath: tab.repo?.localPath ?? preferredRepo?.localPath ?? null,
      branch: tab.repo?.branch ?? preferredRepo?.branch ?? null,
      runtime: null,
      sessionKey: null,
      packet: tab.orchestrationPacket ?? null,
      status: tab.orchestrationPacket?.status ?? null,
      transcriptState: 'no_lane' as const,
      isAdHoc: !tab.orchestrationPacket,
    };
  }

  const status = resolveWorkspaceChatLaneStatus(tab);
  const transcriptState = status === 'recovering'
    ? 'recovering'
    : status === 'blocked' && !tab.chatSessionKey && (tab.chatMessages?.length ?? 0) === 0
      ? 'missing'
      : !tab.chatSessionKey && (tab.chatMessages?.length ?? 0) === 0
        ? 'waiting_activity'
        : 'ready';
  return {
    tileId: stateScope,
    tabId: tab.id,
    kind: tab.kind,
    title: laneDisplayTitle(tab.orchestrationPacket, tab.kind),
    subtitle: tab.repo ? `${tab.repo.name} · ${tab.repo.branch ?? 'main'}` : null,
    repoPath: tab.repo?.localPath ?? preferredRepo?.localPath ?? null,
    branch: tab.repo?.branch ?? preferredRepo?.branch ?? null,
    runtime: tab.orchestrationPacket?.runtime ?? (isAgentRuntimeTab(tab) ? tab.chatRuntime : null),
    sessionKey: normalizeWorkspaceChatSessionKey(tab.chatRuntime, tab.chatSessionKey),
    packet: tab.orchestrationPacket ?? null,
    status,
    transcriptState,
    isAdHoc: !tab.orchestrationPacket,
  };
}

export function sameOrchestrationPacketBadge(left?: TerminalTab['orchestrationPacket'], right?: TerminalTab['orchestrationPacket']) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.packetId === right.packetId
    && left.referenceLabel === right.referenceLabel
    && left.title === right.title
    && left.status === right.status
    && left.runtime === right.runtime
    && left.branchTarget === right.branchTarget;
}

// Problem C — exhaustive dispatch switch: each runtime has a unique session-key prefix scheme.
// codex supports multiple prefixes (codex:, codex-owned:, codex-discovered:, codex-live:).
// Add a new runtime prefix case here when adding a new adapter.
export function normalizeWorkspaceChatSessionKey(
  runtime?: WorkspaceChatRuntime,
  sessionKey?: string | null,
) {
  if (!runtime || !sessionKey) return null;
  const trimmed = sessionKey.trim();
  if (!trimmed) return null;
  // Defensive: if the sessionKey already carries a recognized runtime prefix,
  // trust it and pass through verbatim. Prevents double-prefix artifacts like
  // `codex:gemini-owned:...` when a caller passes runtime='codex' but the lane
  // is actually gemini-owned (happens when mutation record arrives with a
  // stale runtime hint).
  if (
    trimmed.startsWith('llm-chat:')
    || trimmed.startsWith('claude-code:')
    || trimmed.startsWith('codex:')
    || trimmed.startsWith('codex-owned:')
    || trimmed.startsWith('codex-discovered:')
    || trimmed.startsWith('codex-live:')
    || trimmed.startsWith('gemini-owned:')
    || trimmed.startsWith('opencode-owned:')
    || trimmed.startsWith('cursor-owned:')
    || trimmed.startsWith('grok-owned:')
  ) {
    return trimmed;
  }
  if (runtime === 'chat') return `llm-chat:${trimmed}`;
  if (runtime === 'claude-code') return `claude-code:${trimmed}`;
  if (runtime === 'codex') return `codex:${trimmed}`;
  if (runtime === 'gemini') return `gemini-owned:${trimmed}`;
  if (runtime === 'opencode') return `opencode-owned:${trimmed}`;
  if (runtime === 'cursor') return `cursor-owned:${trimmed}`;
  if (runtime === 'grok' || runtime === 'pi') return `grok-owned:${trimmed}`;
  return trimmed;
}

export function formatWorkspaceChatSessionKey(
  runtime?: WorkspaceChatRuntime,
  sessionKey?: string | null,
) {
  return normalizeWorkspaceChatSessionKey(runtime, sessionKey);
}

export function runtimeTransportSessionId(
  runtime?: WorkspaceChatRuntime,
  sessionKey?: string | null,
) {
  const normalized = normalizeWorkspaceChatSessionKey(runtime, sessionKey);
  if (!normalized) return undefined;
  if (runtime === 'claude-code' && normalized.startsWith('claude-code:')) {
    return normalized.slice('claude-code:'.length);
  }
  if (runtime === 'codex') {
    if (normalized.startsWith('codex:')) return normalized.slice('codex:'.length);
    if (normalized.startsWith('codex-discovered:')) return normalized.slice('codex-discovered:'.length);
  }
  if (runtime === 'gemini' && normalized.startsWith('gemini-owned:')) {
    return normalized.slice('gemini-owned:'.length);
  }
  if (runtime === 'opencode' && normalized.startsWith('opencode-owned:')) {
    return normalized.slice('opencode-owned:'.length);
  }
  if (runtime === 'cursor' && normalized.startsWith('cursor-owned:')) {
    return normalized.slice('cursor-owned:'.length);
  }
  if (runtime === 'grok' && normalized.startsWith('grok-owned:')) {
    return normalized.slice('grok-owned:'.length);
  }
  return undefined;
}

export function isOwnedCodexRuntimeSession(sessionKey?: string | null) {
  return sessionKey?.trim().startsWith('codex-owned:') ?? false;
}

/**
 * True for any owned CLI runtime session key.
 * Used to route the chat-pane send path through the generic /api/runtime/action
 * steering verb instead of the runtime-specific /api/<runtime>/send endpoints.
 */
export function isOwnedCliRuntimeSession(sessionKey?: string | null) {
  const key = sessionKey?.trim();
  if (!key) return false;
  return key.startsWith('codex-owned:')
    || key.startsWith('claude-code-owned:')
    || key.startsWith('gemini-owned:')
    || key.startsWith('opencode-owned:')
    || key.startsWith('cursor-owned:')
    || key.startsWith('grok-owned:');
}

export function resolveWorkspaceChatLaneStatus(tab: TerminalTab) {
  if (tab.orchestrationPacket?.status) return tab.orchestrationPacket.status;
  const supervisorStatus = tab.supervisorStatus?.trim().toLowerCase();
  if (supervisorStatus === 'launched' || supervisorStatus === 'retrying') return 'launching';
  if (supervisorStatus === 'running' || supervisorStatus === 'waiting') return 'running';
  if (supervisorStatus === 'completed') return 'awaiting_review';
  if (supervisorStatus === 'stuck' || supervisorStatus === 'interrupted') return 'blocked';
  if (supervisorStatus === 'failed') return 'blocked';
  return tab.chatSessionKey ? 'running' : 'launching';
}

export function packetStatusFromSupervisorStatus(
  supervisorStatus?: string | null,
  currentStatus?: WorkspaceOrchestrationPacketBadge['status'] | null,
): WorkspaceOrchestrationPacketBadge['status'] | null {
  const normalized = supervisorStatus?.trim().toLowerCase();
  if (!normalized) return currentStatus ?? null;
  if (normalized === 'launched' || normalized === 'retrying') return 'launching';
  if (normalized === 'running' || normalized === 'waiting') return 'running';
  if (normalized === 'completed') return 'awaiting_review';
  if (normalized === 'failed' || normalized === 'stuck' || normalized === 'interrupted') return 'blocked';
  return currentStatus ?? null;
}

export function createWorkspaceTabId(kind: TerminalTab['kind']) {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  if (kind === 'llm-chat') return `llm-${uuid}`;
  if (kind === 'canvas') return `canvas-${uuid}`;
  if (kind === 'chat') return `chat-${uuid}`;
  if (kind === 'orchestrator') return `orchestrator-${uuid}`;
  if (kind === 'fleet-canvas') return `fleet-canvas-${uuid}`;
  return `tab-${uuid}`;
}

export function claimWorkspaceTabId(
  kind: TerminalTab['kind'],
  seenTabIds: Set<string>,
  preferredId?: string | null,
) {
  const trimmed = preferredId?.trim();
  if (trimmed && !seenTabIds.has(trimmed)) {
    seenTabIds.add(trimmed);
    return trimmed;
  }
  let nextId = createWorkspaceTabId(kind);
  while (seenTabIds.has(nextId)) {
    nextId = createWorkspaceTabId(kind);
  }
  seenTabIds.add(nextId);
  return nextId;
}

export function transcriptToolSignature(entry: MobileTranscriptEntry) {
  return (entry.toolCalls ?? [])
    .map((tool) => `${tool.name}:${JSON.stringify(tool.args ?? {})}`)
    .join('|');
}

export function sameTranscriptMessages(left: MobileTranscriptEntry[], right: MobileTranscriptEntry[]) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const candidate = right[index];
    if (!candidate) return false;
    return entry.id === candidate.id
      && entry.role === candidate.role
      && entry.text === candidate.text
      && transcriptToolSignature(entry) === transcriptToolSignature(candidate);
  });
}

export function generateLlmChatTabId() {
  return createWorkspaceTabId('llm-chat');
}

export function fallbackWorkspaceChatSessionKey(
  runtime: 'codex' | 'claude-code' | 'gemini' | 'antigravity' | 'opencode' | 'cursor' | 'grok' | 'pi',
  tabId: string,
  scope: string,
) {
  return `${runtime}:ide-tab-${scope}-${tabId}`;
}

export function buildQueuedContextCard(injection: { id: string; text: string; reason?: string; previewImageDataUri?: string }): QueuedContextCard {
  const lines = injection.text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const header = lines[0]?.match(/^\[(.+)\]$/)?.[1] ?? lines[0] ?? 'Context';
  const meta = lines
    .slice(1)
    .filter((line) => /^[A-Za-z][A-Za-z ]+:\s+/.test(line))
    .slice(0, 3);
  const firstBodyLine = lines.find((line) => !/^\[.+\]$/.test(line) && !/^[A-Za-z][A-Za-z ]+:\s+/.test(line));
  const preview = firstBodyLine && firstBodyLine !== header ? firstBodyLine : undefined;

  const title = injection.reason?.startsWith('pr-comment')
    ? (meta[0]?.startsWith('Author:') ? meta[0].replace(/^Author:\s*/, '') : 'PR comment')
    : injection.reason?.startsWith('ci-check')
      ? 'CI context'
      : injection.reason?.startsWith('deploy')
        ? 'Deploy context'
        : header;

  return {
    id: injection.id,
    reason: injection.reason,
    text: injection.text,
    title,
    meta,
    preview,
    previewImageDataUri: injection.previewImageDataUri,
  };
}

export function parseWorkspaceTaskLabel(label: string) {
  const issueMatch = label.match(/^Issue #(\d+)/i);
  if (issueMatch?.[1]) {
    return { kind: 'issue' as const, number: issueMatch[1] };
  }
  const prMatch = label.match(/^PR #(\d+)/i);
  if (prMatch?.[1]) {
    return { kind: 'pr' as const, number: prMatch[1] };
  }
  return null;
}

export function buildCheckpointLabel(tab: TerminalTab, messages: MobileTranscriptEntry[]) {
  const lastUser = [...messages].reverse().find((entry) => entry.role === 'user' && entry.text.trim());
  const taskMeta = parseWorkspaceTaskLabel(tab.label);
  const base = taskMeta
    ? tab.label
    : (lastUser?.text.trim().split('\n')[0] ?? tab.label ?? 'Checkpoint');
  const trimmed = base.replace(/\s+/g, ' ').trim();
  return trimmed.length > 56 ? `${trimmed.slice(0, 56)}…` : trimmed;
}

export function workspaceToolLabel(toolName: string, args?: Record<string, unknown>) {
  if (toolName === 'search_web') return `Searching "${String(args?.query ?? '')}"`;
  if (toolName === 'read_file' || toolName === 'Read') {
    return `Reading ${String(args?.path ?? args?.file_path ?? '').split('/').pop() || 'file'}`;
  }
  if (toolName === 'search_code' || toolName === 'Grep') return `Searching code for "${String(args?.query ?? args?.pattern ?? '')}"`;
  if (toolName === 'list_files' || toolName === 'Glob') return `Listing ${String(args?.path ?? args?.pattern ?? '.')}`;
  if (toolName === 'create_github_issue') return 'Creating GitHub issue';
  if (toolName === 'read_github_issue_or_pr') return `Reading #${String(args?.number ?? '')}`;
  if (toolName === 'create_pull_request') return 'Creating pull request';
  if (toolName === 'Bash') return `Running ${String(args?.description ?? 'shell command')}`;
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') return `Editing ${String(args?.file_path ?? args?.path ?? 'files')}`;
  if (toolName === 'Task') return `Running task ${String(args?.description ?? '')}`.trim();
  if (toolName === 'WebFetch') return `Fetching ${String(args?.url ?? 'web page')}`;
  if (toolName === 'WebSearch') return `Searching "${String(args?.query ?? '')}"`;
  if (toolName === 'Skill') return `Using skill ${String(args?.skill ?? '')}`.trim();
  return `Running ${toolName}`;
}

export function buildWorkspaceThinkingStep(tool: MobileTranscriptToolCall): MobileTranscriptThinkingStep {
  const toolName = tool.name;
  return {
    type: toolName === 'search_web' || toolName === 'search_code' || toolName === 'WebSearch'
      ? 'search'
      : toolName === 'read_file' || toolName === 'list_files' || toolName === 'Read' || toolName === 'Glob'
        ? 'reading'
        : toolName === 'Bash'
          ? 'analyzing'
          : 'tool',
    label: workspaceToolLabel(toolName, tool.args),
    status: tool.status === 'done' ? 'complete' : tool.status === 'calling' ? 'pending' : 'active',
    detail: typeof tool.preview === 'string' ? tool.preview : undefined,
  };
}

export function upsertWorkspaceToolCall(previous: MobileTranscriptToolCall[], next: MobileTranscriptToolCall) {
  const existingIndex = previous.findIndex((tool) => tool.name === next.name);
  if (existingIndex >= 0) {
    return previous.map((tool, index) => (
      index === existingIndex ? { ...tool, ...next, status: next.status ?? tool.status } : tool
    ));
  }
  return [...previous, next];
}

export function mergeTranscriptEntries(current: MobileTranscriptEntry[], incoming: MobileTranscriptEntry[]) {
  const unusedCurrent = [...current];
  const mergedIncoming = incoming.map((entry) => {
    const incomingTools = transcriptToolSignature(entry);
    const matchIndex = unusedCurrent.findIndex((candidate) => (
      candidate.role === entry.role
      && candidate.text.trim() === entry.text.trim()
      && transcriptToolSignature(candidate) === incomingTools
    ));
    if (matchIndex < 0) return entry;
    const [matched] = unusedCurrent.splice(matchIndex, 1);
    return {
      ...entry,
      model: entry.model ?? matched.model,
      tokens: entry.tokens ?? matched.tokens,
      costUsd: entry.costUsd ?? matched.costUsd,
      sources: entry.sources ?? matched.sources,
      thinking: entry.thinking ?? matched.thinking,
      thinkingSteps: entry.thinkingSteps ?? matched.thinkingSteps,
      thinkingDurationMs: entry.thinkingDurationMs ?? matched.thinkingDurationMs,
      recalledFacts: entry.recalledFacts ?? matched.recalledFacts,
      toolCalls: entry.toolCalls ?? matched.toolCalls,
    };
  });
  const latestIncomingTs = mergedIncoming.reduce((max, entry) => Math.max(max, entry.timestamp ?? 0), 0);
  const trailingLocal = unusedCurrent
    .filter((entry) => {
      const ts = entry.timestamp ?? 0;
      if (entry.id.startsWith('msg-')) return true;
      if (entry.id.startsWith('stream:')) return true;
      return latestIncomingTs > 0 && ts >= latestIncomingTs;
    })
    .filter((entry) => !mergedIncoming.some((candidate) => (
      candidate.role === entry.role
      && candidate.text.trim() === entry.text.trim()
      && transcriptToolSignature(candidate) === transcriptToolSignature(entry)
    )))
    .sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
  return [...mergedIncoming, ...trailingLocal];
}

export function inferWorkspaceTaskState(tab: TerminalTab) {
  const messages = tab.chatMessages ?? [];
  const latestAssistant = [...messages].reverse().find((entry) => entry.role === 'assistant' || entry.role === 'system');
  return deriveWorkflowStage({
    autoQueued: tab.chatDraftInjection?.autoSend ?? false,
    latestText: latestAssistant?.text ?? '',
    lastActivityAt: tab.lastActivity,
    hasMessages: messages.length > 0,
  });
}

export function summarizeWorkspaceTabText(value?: string | null, maxWords = 3) {
  const trimmed = value?.replace(/\s+/g, ' ').trim() ?? '';
  if (!trimmed) return null;
  const words = trimmed
    .toLowerCase()
    .split(' ')
    .map((word) => word.trim())
    .filter(Boolean)
    .slice(0, maxWords);
  return words.length > 0 ? words.join(' ') : null;
}

export function describeWorkspaceChatTab(tab: TerminalTab) {
  const isOrchestratorChatTab = tab.kind === 'orchestrator';
  if (tab.kind !== 'chat' && tab.kind !== 'llm-chat' && !isOrchestratorChatTab) return null;
  const latestDraft = tab.kind === 'chat'
    ? (tab.chatDraftInjection?.text ?? null)
    : tab.kind === 'llm-chat'
      ? (tab.llmDraftInjection?.text ?? null)
      : null;
  let fullSummarySource: string | null;
  if (isOrchestratorChatTab) {
    fullSummarySource = tab.llmSummary ?? null;
  } else if (tab.kind === 'llm-chat') {
    fullSummarySource = tab.llmSummary ?? latestDraft ?? null;
  } else {
    const messages = tab.chatMessages ?? [];
    const latestUser = [...messages].reverse().find((entry) => (
      entry.role === 'user'
      && entry.text.trim()
      && !/^(hi|hey|hello)\b/i.test(entry.text.trim())
    ));
    const latestAssistant = [...messages].reverse().find((entry) => (
      (entry.role === 'assistant' || entry.role === 'system')
      && entry.text.trim()
    ));
    fullSummarySource = latestUser?.text ?? latestDraft ?? latestAssistant?.text ?? null;
  }
  const fullSummary = fullSummarySource?.replace(/\s+/g, ' ').trim() ?? null;
  const summary = summarizeWorkspaceTabText(fullSummary, 3);
  const repoLabel = tab.repo?.name ?? (tab.repo?.localPath ? tab.repo.localPath.split('/').pop() : null);
  const detailParts = tab.repo?.isWorktree
    ? [tab.repo.branch ?? null, repoLabel, tab.repo.worktreeStatus ?? 'workspace']
    : [tab.repo?.branch ?? null, repoLabel];
  return {
    fullSummary,
    summary,
    repoLabel,
    detail: detailParts.filter((value): value is string => Boolean(value)).join(' · ') || null,
  };
}

export function workspaceConversationHeaderLabel(tab: TerminalTab) {
  const meta = describeWorkspaceChatTab(tab);
  if (!meta) return null;
  const repoLabel = meta.repoLabel ?? tab.repo?.name ?? null;
  const tabLabel = tab.label?.trim() ?? '';
  const title = tabLabel
    && !/^ad\s*hoc/i.test(tabLabel)
    && !/^chat-/i.test(tabLabel)
    && tabLabel !== 'Assistant'
    && tabLabel !== 'Agent'
    && tabLabel !== 'Chat'
    && tabLabel !== 'Orchestrator'
    ? tabLabel
    : meta.fullSummary
    ?? meta.summary
    ?? workspaceTabPrimaryLabel(tab);
  if (!title) return repoLabel;
  if (repoLabel && title !== repoLabel && !title.startsWith(`${repoLabel} /`)) {
    return `${repoLabel} / ${title}`;
  }
  return title;
}

export function workspaceTabPrimaryLabel(tab: TerminalTab) {
  if (tab.orchestrationPacket) {
    return laneDisplayTitle(tab.orchestrationPacket, tab.kind);
  }
  if (tab.kind === 'orchestrator' && tab.mode === 'single') {
    return orchestratorRuntimeTone(tab.singleRuntime ?? 'codex').label;
  }
  if (tab.label && !/^ad\s*hoc/i.test(tab.label) && !/^chat-/.test(tab.label) && !/^terminal-/.test(tab.label) && tab.label !== 'Assistant' && tab.label !== 'Agent') {
    return tab.label;
  }
  if (tab.kind === 'llm-chat') {
    return adHocLaneTitle('llm-chat');
  }
  if (tab.kind === 'chat') {
    // Show repo + runtime instead of generic "Assistant"
    const repoName = tab.repo?.name ?? (tab.repo?.localPath ? tab.repo.localPath.split('/').pop() : null);
    const runtimeShort = tab.chatRuntime === 'claude-code' ? 'Claude'
      : tab.chatRuntime === 'codex' ? 'Codex'
      : tab.chatRuntime === 'gemini' ? 'Gemini'
      : tab.chatRuntime === 'opencode' ? 'opencode'
      : null;
    if (repoName && runtimeShort) return `${repoName} (${runtimeShort})`;
    if (repoName) return repoName;
    if (runtimeShort) return runtimeShort;
    return adHocLaneTitle('chat');
  }
  if (tab.kind === 'terminal') {
    return adHocLaneTitle('terminal');
  }
  return tab.label;
}
