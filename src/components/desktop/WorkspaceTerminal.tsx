'use client';
/* eslint-disable @next/next/no-img-element -- terminal image previews intentionally use raw panel-served URLs */

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { isTauri } from '@/lib/tauri/bridge';
import { Plus, X, Terminal as TerminalIcon, ChevronDown, ChevronRight, Crosshair, MessageSquare, Radio, ArrowUp, ArrowDown, Square, AlertCircle, RotateCcw, GitCommit, CheckCircle2 } from 'lucide-react';
/* ── Raw Phosphor SVG icons (React components render as empty boxes in Tauri webview) ── */
function PhosphorPlay({ size = 14 }: { size?: number }) {
  return (<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" viewBox="0 0 256 256" style={{ display: 'block', flexShrink: 0 }}><path d="M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z" /></svg>);
}
function PhosphorSplitVertical({ size = 14 }: { size?: number }) {
  return (<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" viewBox="0 0 256 256" style={{ display: 'block', flexShrink: 0 }}><path d="M208,144H48a8,8,0,0,0,0,16h72v32H96a8,8,0,0,0-5.66,13.66l32,32a8,8,0,0,0,11.32,0l32-32A8,8,0,0,0,160,192H136V160h72a8,8,0,0,0,0-16Zm-80,76.69L115.31,208h25.38ZM48,112H208a8,8,0,0,0,0-16H136V64h24a8,8,0,0,0,5.66-13.66l-32-32a8,8,0,0,0-11.32,0l-32,32A8,8,0,0,0,96,64h24V96H48a8,8,0,0,0,0,16Zm80-76.69L140.69,48H115.31Z" /></svg>);
}
function PhosphorSplitHorizontal({ size = 14 }: { size?: number }) {
  return (<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" viewBox="0 0 256 256" style={{ display: 'block', flexShrink: 0 }}><path d="M104,40a8,8,0,0,0-8,8v72H64V96a8,8,0,0,0-13.66-5.66l-32,32a8,8,0,0,0,0,11.32l32,32A8,8,0,0,0,64,160V136H96v72a8,8,0,0,0,16,0V48A8,8,0,0,0,104,40ZM48,140.69,35.31,128,48,115.31Zm189.66-18.35-32-32A8,8,0,0,0,192,96v24H160V48a8,8,0,0,0-16,0V208a8,8,0,0,0,16,0V136h32v24a8,8,0,0,0,13.66,5.66l32-32A8,8,0,0,0,237.66,122.34ZM208,140.69V115.31L220.69,128Z" /></svg>);
}
function PhosphorXCircle({ size = 14 }: { size?: number }) {
  return (<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" viewBox="0 0 256 256" style={{ display: 'block', flexShrink: 0 }}><path d="M165.66,101.66,139.31,128l26.35,26.34a8,8,0,0,1-11.32,11.32L128,139.31l-26.34,26.35a8,8,0,0,1-11.32-11.32L116.69,128,90.34,101.66a8,8,0,0,1,11.32-11.32L128,116.69l26.34-26.35a8,8,0,0,1,11.32,11.32ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z" /></svg>);
}
function PhosphorCaretLeft({ size = 12 }: { size?: number }) {
  return (<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" viewBox="0 0 256 256" style={{ display: 'block', flexShrink: 0 }}><path d="M165.66,202.34a8,8,0,0,1-11.32,11.32l-80-80a8,8,0,0,1,0-11.32l80-80a8,8,0,0,1,11.32,11.32L91.31,128Z" /></svg>);
}
function PhosphorCaretRight({ size = 12 }: { size?: number }) {
  return (<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" viewBox="0 0 256 256" style={{ display: 'block', flexShrink: 0 }}><path d="M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z" /></svg>);
}
function PhosphorXBold({ size = 10 }: { size?: number }) {
  return (<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" viewBox="0 0 256 256" style={{ display: 'block', flexShrink: 0 }}><path d="M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z" /></svg>);
}
import LLMChat, { ChainOfThought, MessageBubble, type LLMMessage } from './LLMChat';
import { IssueLinkPickerModal, buildLinkedIssueContext, type LinkedIssueRef } from './IssueLinkPicker';
import { Canvas, type CanvasRepoTaskLaunchRequest, type CanvasTab } from './Canvas';
import { useTheme } from '@/lib/theme/context';
import {
  saveTabState,
  loadTabState,
  checkAliveSessions,
  buildRepoStateScope,
  formatPersistedRuntimeSessionKey,
  loadLiveRuntimeSessionKeys,
  stripPersistedRuntimeSessionKey,
  type PersistedChatCheckpoint,
  type PersistedTabState,
} from '@/lib/terminal/tab-state';
import type { MobileInboxSnapshot, MobileTranscriptEntry, MobileTranscriptSource, MobileTranscriptThinkingStep, MobileTranscriptToolCall } from '@/lib/mobile/types';
import type {
  OrchestratorLaneSnapshot,
  WorkspaceLaneState,
  WorkspaceOrchestrationPacketBadge,
} from '@/lib/orchestrator/types';
import {
  adHocLaneTitle,
  laneDisplayTitle,
  orchestratorRuntimeTone,
  orchestratorStatusTone,
} from '@/lib/orchestrator/display';
import {
  persistOrchestratorMissionState,
  readOrchestratorMissionState,
} from '@/lib/orchestrator/store';
import { deriveWorkflowStage } from '@/lib/workflows/status';
import type { RepoReadiness } from '@/lib/repos/types';
import {
  type DetectedLocalhostPreview,
  PREVIEW_HOST_MESSAGE_SOURCE,
  PREVIEW_MESSAGE_SOURCE,
  type PreviewSelectionPayload,
} from '@/lib/panel/preview';

/* ── Types ── */

export interface TerminalTab {
  id: string;
  label: string;
  kind: 'terminal' | 'chat' | 'llm-chat' | 'canvas';
  tmuxSession: string | null; // null = pending creation (terminal only)
  cliAgent?: string; // which CLI agent was launched (or 'shell')
  repo?: RegisteredRepo; // optional repo context
  createdAt: number; // timestamp for elapsed time
  lastActivity: number; // timestamp of last terminal output
  // Chat-specific fields
  chatRuntime?: 'codex' | 'claude-code';
  chatSessionKey?: string; // CLI session ID
  chatModel?: string;
  chatContinueLatest?: boolean;
  chatDraftInjection?: { id: string; text: string; autoSend?: boolean; reason?: string };
  llmDraftInjection?: { id: string; text: string; autoSend?: boolean; reason?: string };
  chatMessages?: MobileTranscriptEntry[];
  llmSummary?: string | null;
  chatCheckpoints?: PersistedChatCheckpoint[];
  linkedIssue?: LinkedIssueRef | null;
  canvasTab?: CanvasTab;
  orchestrationPacket?: WorkspaceOrchestrationPacketBadge | null;
  supervisorStatus?: string | null;
  autoArchiveOnIdle?: boolean;
}

type LocalhostPreview = DetectedLocalhostPreview;

/** Strip ANSI escape sequences from terminal output for URL detection */
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[^[]/g;

/** Detect localhost URLs in terminal output */
const LOCALHOST_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{3,5})\b[^\s)"]*/g;

/** Ports to ignore — the IDE itself runs on these */
const IGNORED_PORTS = new Set([3000, 3002]); // 3000 = Next.js dev, 3002 = WS server
const ORCHESTRATED_TAB_AUTO_ARCHIVE_MS = 10 * 60_000;

type WorkspaceChatRuntime = 'codex' | 'claude-code' | 'chat';

/** True when a tab is bound to an agent runtime (Codex or Claude Code), as
 *  opposed to a plain LLM chat session. Use this single guard
 *  everywhere instead of scattering `chatRuntime === 'codex'` checks. */
export function isAgentRuntimeTab(
  tab: TerminalTab | null | undefined,
): tab is TerminalTab & { kind: 'chat'; chatRuntime: 'codex' | 'claude-code' } {
  return tab?.kind === 'chat'
    && (tab.chatRuntime === 'codex' || tab.chatRuntime === 'claude-code');
}

export interface TerminalTabHandle {
  writeToTerminal: (sessionName: string, data: string) => void;
  writeRaw: (sessionName: string, data: string) => void;
  showImage: (sessionName: string, imageB64: string, filename: string) => void;
  setTermError: (sessionName: string, error: string) => void;
  setTermExited: (sessionName: string) => void;
  onSessionCreated: (sessionName: string, requestId?: string) => boolean;
  clearDetectedPreview: (port: number) => void;
  isRestoreSettled: () => boolean;
  openCliChatSession: (options: {
    runtime?: 'codex' | 'claude-code';
    repo?: RegisteredRepo;
    modelId?: string;
    initialText?: string;
    draftReason?: string;
    autoSend?: boolean;
    createNew?: boolean;
    label?: string;
    targetSessionKey?: string;
    orchestrationPacket?: WorkspaceOrchestrationPacketBadge | null;
    supervisorStatus?: string | null;
    autoArchiveOnIdle?: boolean;
  }) => string;
  injectIntoCliChat: (text: string, options?: {
    runtime?: 'codex' | 'claude-code';
    repo?: RegisteredRepo;
    modelId?: string;
    draftReason?: string;
    autoSend?: boolean;
    createNew?: boolean;
    label?: string;
    targetSessionKey?: string;
    orchestrationPacket?: WorkspaceOrchestrationPacketBadge | null;
    supervisorStatus?: string | null;
    autoArchiveOnIdle?: boolean;
  }) => string;
  focusTab: (tabId: string) => boolean;
  setOrchestrationPacket: (tabId: string, packet: WorkspaceOrchestrationPacketBadge | null) => boolean;
  updateChatRuntimeStatus: (sessionKey: string, status: string, label?: string) => boolean;
  getChatTabSnapshots: () => OrchestratorLaneSnapshot[];
  openWorkspaceDiff: () => void;
  openInspectorTab: (tab: CanvasTab, options?: { repo?: RegisteredRepo; createNew?: boolean }) => string;
}

interface WorkspaceTerminalProps {
  stateScope: string;
  defaultTab: 'llm-chat' | 'terminal';
  autoCreateDefaultTab?: boolean;
  preferredRepo?: RegisteredRepo | null;
  splitCreated?: boolean;
  availableRepos?: RegisteredRepo[];
  openRepoPaths?: string[];
  onActiveChatSessionChange?: (sessionKey: string | null) => void;
  onChatSessionsChange?: (sessions: MobileInboxSnapshot['sessions']) => void;
  onActiveLaneChange?: (lane: WorkspaceLaneState | null) => void;
  onRepoScopeChange?: (repoPath: string | null) => void;
  onActiveRepoContextChange?: (repo: RegisteredRepo | null) => void;
  onSelectRepoScope?: (repo: RegisteredRepo) => void;
  onLaunchRepoAgent?: (repo: RegisteredRepo) => void | Promise<void>;
  onOpenRepoGitLog?: (repo: RegisteredRepo) => void;
  onOpenRepoCI?: (repo: RegisteredRepo) => void;
  onOpenRepoDiff?: (repo: RegisteredRepo | null) => void;
  onInjectChatContext?: (payload: import('@/lib/chat/injection').AgentPanelChatInjectionPayload) => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onLaunchWorkspaceTask?: (request: CanvasRepoTaskLaunchRequest) => Promise<void>;
  onSplitVertical?: () => void;
  onSplitHorizontal?: () => void;
  canCloseTile?: boolean;
  onCloseTile?: () => void;
  sendTerminalCreate: (cols: number, rows: number, requestId?: string) => void;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
  termWsConnected: boolean;
  onPreviewDetected?: (preview: DetectedLocalhostPreview) => void;
  onPreviewSelection?: (selection: PreviewSelectionPayload) => void;
  showPreviewPane?: boolean;
}

const CLI_AGENTS = [
  { id: 'shell', label: 'Terminal', color: '#64748b', command: null },
  { id: 'claude', label: 'Claude Code', color: '#e07a3a', command: 'claude' },
  { id: 'codex', label: 'Codex', color: '#6b7280', command: 'codex' },
  { id: 'gemini', label: 'Gemini CLI', color: '#4285f4', command: 'gemini' },
  { id: 'opencode', label: 'OpenCode', color: '#f97316', command: 'opencode' },
  { id: 'aider', label: 'Aider', color: '#eab308', command: 'aider' },
];

interface RegisteredRepo {
  name: string;
  localPath: string;
  remoteUrl?: string;
  branch?: string | null;
  readiness?: RepoReadiness | null;
  registryRepoId?: string;
  isWorktree?: boolean;
  worktreeStatus?: string | null;
}

function shortenPath(value: string) {
  const userPath = value.replace(/^\/Users\/[^/]+/, '~');
  if (userPath !== value) return userPath;
  return value.replace(/^\/home\/[^/]+/, '~');
}

function repoSlugFromRemote(remoteUrl?: string | null) {
  if (!remoteUrl) return null;
  const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  return match?.[1] ?? null;
}

function activeManualLaneStatus(tab: TerminalTab | null) {
  if (!tab) return orchestratorStatusTone('idle');
  if (tab.kind === 'chat') {
    return orchestratorStatusTone(resolveWorkspaceChatLaneStatus(tab));
  }
  if (tab.kind === 'terminal') {
    return orchestratorStatusTone(tab.tmuxSession ? 'running' : 'launching');
  }
  return orchestratorStatusTone('idle');
}

function manualLaneRuntimeTone(tab: TerminalTab | null) {
  if (!tab) return null;
  if (tab.kind === 'chat') {
    return orchestratorRuntimeTone(tab.chatRuntime);
  }
  if (tab.kind === 'terminal') {
    if (tab.cliAgent === 'claude') return orchestratorRuntimeTone('claude-code');
    if (tab.cliAgent === 'codex') return orchestratorRuntimeTone('codex');
    const agent = CLI_AGENTS.find(a => a.id === tab.cliAgent);
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

function buildWorkspaceLaneState(
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
      transcriptState: 'no_lane',
      isAdHoc: true,
    };
  }

  if (tab.kind !== 'chat') {
    return {
      tileId: stateScope,
      tabId: tab.id,
      kind: tab.kind,
      title: laneDisplayTitle(tab.orchestrationPacket, tab.kind),
      subtitle: tab.repo
        ? `${tab.repo.name} · ${tab.repo.branch ?? 'main'}`
        : null,
      repoPath: tab.repo?.localPath ?? preferredRepo?.localPath ?? null,
      branch: tab.repo?.branch ?? preferredRepo?.branch ?? null,
      runtime: null,
      sessionKey: null,
      packet: tab.orchestrationPacket ?? null,
      status: tab.orchestrationPacket?.status ?? null,
      transcriptState: 'no_lane',
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
    subtitle: tab.repo
      ? `${tab.repo.name} · ${tab.repo.branch ?? 'main'}`
      : null,
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

function sameOrchestrationPacketBadge(
  left: WorkspaceOrchestrationPacketBadge | null | undefined,
  right: WorkspaceOrchestrationPacketBadge | null | undefined,
) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.packetId === right.packetId
    && left.referenceLabel === right.referenceLabel
    && left.title === right.title
    && left.status === right.status
    && left.runtime === right.runtime
    && left.branchTarget === right.branchTarget;
}

function normalizeWorkspaceChatSessionKey(
  runtime?: WorkspaceChatRuntime,
  sessionKey?: string | null,
) {
  if (!runtime || !sessionKey) return null;
  const trimmed = sessionKey.trim();
  if (!trimmed) return null;
  if (runtime === 'chat') return trimmed.startsWith('llm-chat:') ? trimmed : `llm-chat:${trimmed}`;
  if (runtime === 'claude-code') return trimmed.startsWith('claude-code:') ? trimmed : `claude-code:${trimmed}`;
  if (runtime === 'codex') {
    if (
      trimmed.startsWith('codex:')
      || trimmed.startsWith('codex-owned:')
      || trimmed.startsWith('codex-discovered:')
      || trimmed.startsWith('codex-live:')
    ) {
      return trimmed;
    }
    return `codex:${trimmed}`;
  }
  return trimmed;
}

function formatWorkspaceChatSessionKey(
  runtime?: WorkspaceChatRuntime,
  sessionKey?: string | null,
) {
  return normalizeWorkspaceChatSessionKey(runtime, sessionKey);
}

function runtimeTransportSessionId(
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
  return undefined;
}

function isOwnedCodexRuntimeSession(sessionKey?: string | null) {
  return sessionKey?.trim().startsWith('codex-owned:') ?? false;
}

function resolveWorkspaceChatLaneStatus(tab: TerminalTab) {
  if (tab.orchestrationPacket?.status) return tab.orchestrationPacket.status;
  const supervisorStatus = tab.supervisorStatus?.trim().toLowerCase();
  if (supervisorStatus === 'launched' || supervisorStatus === 'retrying') return 'launching';
  if (supervisorStatus === 'running' || supervisorStatus === 'waiting') return 'running';
  if (supervisorStatus === 'completed') return 'awaiting_review';
  if (supervisorStatus === 'stuck' || supervisorStatus === 'interrupted') return 'blocked';
  if (supervisorStatus === 'failed') return 'blocked';
  return tab.chatSessionKey ? 'running' : 'launching';
}

function packetStatusFromSupervisorStatus(
  supervisorStatus?: string | null,
  currentStatus?: WorkspaceOrchestrationPacketBadge['status'] | null,
) {
  const normalized = supervisorStatus?.trim().toLowerCase();
  if (!normalized) return currentStatus ?? null;
  if (normalized === 'launched' || normalized === 'retrying') return 'launching';
  if (normalized === 'running' || normalized === 'waiting') return 'running';
  if (normalized === 'completed') return 'awaiting_review';
  if (normalized === 'failed' || normalized === 'stuck' || normalized === 'interrupted') return 'blocked';
  return currentStatus ?? null;
}

function createWorkspaceTabId(kind: TerminalTab['kind']) {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  if (kind === 'llm-chat') return `llm-${uuid}`;
  if (kind === 'canvas') return `canvas-${uuid}`;
  if (kind === 'chat') return `chat-${uuid}`;
  return `tab-${uuid}`;
}

function claimWorkspaceTabId(
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

function sameTranscriptMessages(left: MobileTranscriptEntry[], right: MobileTranscriptEntry[]) {
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

function generateLlmChatTabId() {
  return createWorkspaceTabId('llm-chat');
}

function fallbackWorkspaceChatSessionKey(
  runtime: 'codex' | 'claude-code',
  tabId: string,
  scope: string,
) {
  return `${runtime}:ide-tab-${scope}-${tabId}`;
}

function SplitVerticalIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 4v16" />
      <path d="M6 7v10" />
      <path d="M18 7v10" />
    </svg>
  );
}

function SplitHorizontalIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M4 12h16" />
      <path d="M7 6h10" />
      <path d="M7 18h10" />
    </svg>
  );
}

interface WorkspaceCliModelOption {
  id: string;
  label: string;
  color: string;
}

const CLAUDE_CLI_MODELS: WorkspaceCliModelOption[] = [
  { id: 'claude-opus-4-6', label: 'Opus 4.6', color: '#8b5cf6' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', color: '#8b5cf6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', color: '#8b5cf6' },
];

const CODEX_CLI_MODELS: WorkspaceCliModelOption[] = [
  { id: 'gpt-5.4', label: 'GPT-5.4', color: '#10b981' },
  { id: 'gpt-4o', label: 'GPT-4o', color: '#10b981' },
];

interface QueuedContextCard {
  id: string;
  reason?: string;
  text: string;
  title: string;
  meta: string[];
  preview?: string;
}

function buildQueuedContextCard(injection: { id: string; text: string; reason?: string }): QueuedContextCard {
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
  };
}

function buildCheckpointLabel(tab: TerminalTab, messages: MobileTranscriptEntry[]) {
  const lastUser = [...messages].reverse().find((entry) => entry.role === 'user' && entry.text.trim());
  const taskMeta = parseWorkspaceTaskLabel(tab.label);
  const base = taskMeta
    ? tab.label
    : (lastUser?.text.trim().split('\n')[0] ?? tab.label ?? 'Checkpoint');
  const trimmed = base.replace(/\s+/g, ' ').trim();
  return trimmed.length > 56 ? `${trimmed.slice(0, 56)}…` : trimmed;
}

const CLI_SUGGESTED_PROMPTS = [
  { icon: '💡', text: 'Summarize the current repo state', description: 'Quickly orient this CLI session to the local checkout' },
  { icon: '🔍', text: 'Find the files related to the current bug', description: 'Search the repo and point me to the likely change surface' },
  { icon: '🧪', text: 'Tell me what tests I should run next', description: 'Use the current branch and recent changes as context' },
  { icon: '📝', text: 'Explain what changed on this branch', description: 'Read the local diff and summarize the work in progress' },
];

const THEME_ACCENT = 'var(--t-accent, #2563eb)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
const THEME_ACCENT_SOFT_STRONG = 'var(--t-accent-soft-strong, rgba(37, 99, 235, 0.14))';
const THEME_ACCENT_BORDER = 'var(--t-accent-border, rgba(37, 99, 235, 0.22))';
const THEME_ACCENT_RING = 'var(--t-accent-ring, rgba(37, 99, 235, 0.15))';
const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
const THEME_PANEL = 'var(--t-panel)';
const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';

function readThemeColor(name: string, fallback: string) {
  if (typeof window === 'undefined') return fallback;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function buildXtermTheme() {
  return {
    background: '#ffffff',
    foreground: '#111827',
    cursor: '#2563eb',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(37, 99, 235, 0.15)',
    selectionForeground: '#111827',
    black: '#111827',
    red: '#dc2626',
    green: '#16a34a',
    yellow: '#ca8a04',
    blue: '#2563eb',
    magenta: '#9333ea',
    cyan: '#0891b2',
    white: '#e5e7eb',
    brightBlack: '#6b7280',
    brightRed: '#ef4444',
    brightGreen: '#22c55e',
    brightYellow: '#eab308',
    brightBlue: '#3b82f6',
    brightMagenta: '#a855f7',
    brightCyan: '#06b6d4',
    brightWhite: '#f9fafb',
  };
}

/** Small colored dot for tab/picker items */
function AgentDot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <span style={{
      display: 'inline-block',
      width: size,
      height: size,
      borderRadius: '50%',
      background: color,
      flexShrink: 0,
    }} />
  );
}

function CortexMarkIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path
        d="M17.7 6.6a7.1 7.1 0 1 0 0 10.8"
        stroke="#ec4899"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle cx="16.8" cy="6.1" r="1.55" fill="#ec4899" />
      <circle cx="18.2" cy="12" r="1.35" fill="#ec4899" />
      <circle cx="16.8" cy="17.9" r="1.55" fill="#ec4899" />
      <circle cx="8.3" cy="6.9" r="1.15" fill="#f472b6" opacity="0.95" />
      <circle cx="6.6" cy="12" r="1.05" fill="#f472b6" opacity="0.85" />
      <circle cx="8.3" cy="17.1" r="1.15" fill="#f472b6" opacity="0.95" />
    </svg>
  );
}

function ClaudeTabIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <rect
        x="2.5"
        y="2.5"
        width="19"
        height="19"
        rx="5.25"
        fill="#e97a4d"
        stroke="rgba(255,255,255,0.22)"
        strokeWidth="1"
      />
      <path
        d="M12 5.8v12.4M6.75 7.8l10.5 8.4M17.25 7.8 6.75 16.2M8.5 5.95 15.5 18.05M15.5 5.95 8.5 18.05"
        stroke="#fff"
        strokeWidth="1.95"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="1.6" fill="#fff" />
    </svg>
  );
}

function CodexTabIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path
        d="M12 4.9 16.9 7.7 16.9 13.25 12 16.05 7.1 13.25 7.1 7.7 12 4.9Z"
        stroke="#b7c3d4"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 8.1 14.95 9.8 14.95 13.2 12 14.9 9.05 13.2 9.05 9.8 12 8.1Z"
        fill="#d8e1ec"
        opacity="0.96"
      />
      <path
        d="M7.1 7.7 12 10.45 16.9 7.7"
        stroke="#b7c3d4"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 10.45V16.05"
        stroke="#8ea3bd"
        strokeWidth="1.55"
        strokeLinecap="round"
      />
    </svg>
  );
}

function WorkspaceCliModelPicker({
  selected,
  models,
  disabled,
  onSelect,
}: {
  selected: WorkspaceCliModelOption;
  models: WorkspaceCliModelOption[];
  disabled: boolean;
  onSelect: (modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [dropPos, setDropPos] = useState({ bottom: 0, right: 0 });

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (dropRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setDropPos({
      bottom: window.innerHeight - rect.top + 6,
      right: window.innerWidth - rect.right,
    });
  }, [open]);

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 6,
          paddingBottom: 6,
          paddingLeft: 10,
          paddingRight: 10,
          borderRadius: 999,
          background: THEME_BG_CARD,
          border: '1px solid var(--t-panel-border)',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--t-text-secondary)',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: selected.color }} />
        {selected.label}
        <ChevronDown size={11} style={{ color: 'var(--t-text-muted)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms ease' }} />
      </button>

      {open && (
        <div
          ref={dropRef}
          style={{
            position: 'fixed',
            bottom: dropPos.bottom,
            right: dropPos.right,
            zIndex: 9999,
            minWidth: 220,
            background: THEME_PANEL_GLASS,
            border: '1px solid var(--t-panel-border)',
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: 'var(--t-panel-shadow)',
          }}
        >
          {models.map((model) => (
            <button
              key={model.id}
              type="button"
              onClick={() => { onSelect(model.id); setOpen(false); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                paddingTop: 8,
                paddingBottom: 8,
                paddingLeft: 12,
                paddingRight: 12,
                border: 'none',
                background: model.id === selected.id ? THEME_ACCENT_SOFT : 'transparent',
                color: 'var(--t-text)',
                fontSize: 13,
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = THEME_ACCENT_SOFT; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = model.id === selected.id ? THEME_ACCENT_SOFT : 'transparent'; }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: model.color, flexShrink: 0 }} />
              <span style={{ fontWeight: 500 }}>{model.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Inline xterm.js Terminal ── */

interface XtermPanelProps {
  tmuxSession: string;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
  visible: boolean;
}

interface InlineImage {
  id: string;
  dataUrl: string;
  filename: string;
}

interface XtermPanelHandle {
  writeData: (data: string) => void;
  writeRaw: (data: string) => void;
  showImage: (imageB64: string, filename: string) => void;
  setError: (error: string) => void;
  setExited: () => void;
}

const XtermPanel = forwardRef<XtermPanelHandle, XtermPanelProps>(function XtermPanel(
  { tmuxSession, sendTerminalAttach, sendTerminalInput, sendTerminalResize, sendTerminalDetach, visible },
  ref,
) {
  const { themeId } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const termRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fitAddonRef = useRef<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const [inlineImages, setInlineImages] = useState<InlineImage[]>([]);
  const imageCountRef = useRef(0);

  useImperativeHandle(ref, () => ({
    writeData: (data: string) => {
      if (!termRef.current) return;
      try {
        // Decode base64 → Uint8Array → proper UTF-8 (atob mangles multi-byte chars)
        const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        termRef.current.write(bytes);
      } catch { /* ignore decode errors */ }
    },
    showImage: (imageB64: string, filename: string) => {
      // Detect mime type from filename
      const ext = filename.split('.').pop()?.toLowerCase() ?? 'png';
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'svg' ? 'image/svg+xml' : 'image/png';
      const dataUrl = `data:${mime};base64,${imageB64}`;
      imageCountRef.current += 1;
      setInlineImages(prev => [...prev, { id: `img-${imageCountRef.current}`, dataUrl, filename }]);
      // Write a newline placeholder in xterm so the prompt moves down
      if (termRef.current) {
        termRef.current.write('\r\n\r\n');
      }
    },
    writeRaw: (data: string) => {
      if (!termRef.current) return;
      try {
        const encoder = new TextEncoder();
        termRef.current.write(encoder.encode(data));
      } catch { /* ignore */ }
    },
    setError: (err: string) => setError(err),
    setExited: () => setExited(true),
  }), []);

  // Refit when visibility changes
  useEffect(() => {
    if (visible && fitAddonRef.current) {
      // Small delay to let layout settle
      const t = setTimeout(() => {
        try {
          fitAddonRef.current?.fit();
          if (termRef.current) {
            sendTerminalResize(tmuxSession, termRef.current.cols, termRef.current.rows);
          }
        } catch { /* ignore */ }
      }, 50);
      return () => clearTimeout(t);
    }
  }, [visible, tmuxSession, sendTerminalResize]);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;

    async function init() {
      try {
        const [{ Terminal }, { FitAddon }, { WebLinksAddon }, { SearchAddon }, { Unicode11Addon }, { ImageAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          import('@xterm/addon-web-links'),
          import('@xterm/addon-search'),
          import('@xterm/addon-unicode11'),
          import('@xterm/addon-image'),
        ]);
        if (disposed) return;

        // Inject CSS once
        if (!document.getElementById('xterm-css')) {
          const link = document.createElement('link');
          link.id = 'xterm-css';
          link.rel = 'stylesheet';
          link.href = '/xterm.css';
          document.head.appendChild(link);
        }

        const term = new Terminal({
          fontFamily: 'ui-monospace, "SF Mono", Monaco, Menlo, monospace',
          fontSize: 12,
          lineHeight: 1.35,
          cursorBlink: true,
          cursorStyle: 'block',
          allowTransparency: true,
          allowProposedApi: true,
          scrollback: 10000,
          theme: buildXtermTheme(),
        });

        const fitAddon = new FitAddon();
        const webLinksAddon = new WebLinksAddon();
        const searchAddon = new SearchAddon();
        const unicode11Addon = new Unicode11Addon();
        const imageAddon = new ImageAddon({
          enableSizeReports: true,
          pixelLimit: 16777216, // 4096x4096 max
          sixelSupport: true,
          sixelScrolling: true,
          sixelPaletteLimit: 4096,
          iipSupport: true, // iTerm2 Inline Image Protocol
          iipSizeLimit: 20000000, // 20MB max image size
        });
        term.loadAddon(fitAddon);
        term.loadAddon(webLinksAddon);
        term.loadAddon(searchAddon);
        term.loadAddon(unicode11Addon);
        term.loadAddon(imageAddon);
        term.unicode.activeVersion = '11';

        if (!containerRef.current || disposed) { term.dispose(); return; }

        term.open(containerRef.current);
        fitAddon.fit();
        termRef.current = term;
        fitAddonRef.current = fitAddon;

        // Attach to tmux session
        sendTerminalAttach(tmuxSession, term.cols, term.rows);

        // Wire input
        term.onData((data) => { sendTerminalInput(tmuxSession, data); });

        // Auto-fit on resize
        const observer = new ResizeObserver(() => {
          if (disposed || !fitAddonRef.current) return;
          try {
            fitAddonRef.current.fit();
            sendTerminalResize(tmuxSession, termRef.current.cols, termRef.current.rows);
          } catch { /* ignore */ }
        });
        if (containerRef.current) observer.observe(containerRef.current);

        return () => { observer.disconnect(); };
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : 'Failed to load terminal');
      }
    }

    const cleanupPromise = init();

    return () => {
      disposed = true;
      sendTerminalDetach(tmuxSession);
      cleanupPromise?.then(cleanup => cleanup?.());
      if (termRef.current) { termRef.current.dispose(); termRef.current = null; }
      fitAddonRef.current = null;
    };
  }, [themeId, tmuxSession, sendTerminalAttach, sendTerminalInput, sendTerminalResize, sendTerminalDetach]);

  if (error) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#ef4444', fontSize: 13, fontFamily: 'ui-monospace, monospace',
      }}>
        Terminal error: {error}
      </div>
    );
  }

  if (exited) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#64748b', fontSize: 13, fontFamily: 'ui-monospace, monospace',
      }}>
        Session ended
      </div>
    );
  }

  return (
    <div style={{
      flex: 1,
      width: '100%',
      display: visible ? 'flex' : 'none',
      flexDirection: 'column',
      background: THEME_PANEL,
      borderRadius: 0,
      overflow: 'hidden',
    }}>
      {/* Inline images — rendered above terminal */}
      {inlineImages.map((img) => (
        <div key={img.id} style={{
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 12,
          paddingRight: 12,
          borderBottom: '1px solid var(--t-divider)',
          flexShrink: 0,
        }}>
          <img
            src={img.dataUrl}
            alt={img.filename}
            style={{
              maxWidth: '100%',
              maxHeight: 400,
              borderRadius: 8,
              objectFit: 'contain',
            }}
          />
          <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 4, fontFamily: 'ui-monospace, monospace' }}>
            {img.filename}
          </div>
        </div>
      ))}
      {/* Terminal */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          width: '100%',
          background: THEME_PANEL,
          paddingTop: 2,
          paddingLeft: 2,
        }}
      />
    </div>
  );
});

/* ── Tab Bar ── */

/* ── Localhost Preview Pane ── */

function PreviewToolbar({ preview, selectionEnabled, onToggleSelection, onRefresh, onClose }: {
  preview: LocalhostPreview;
  selectionEnabled: boolean;
  onToggleSelection: () => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      height: 32,
      paddingLeft: 12,
      paddingRight: 8,
      background: '#f1f5f9',
      borderBottom: '1px solid #e2e8f0',
      gap: 8,
      flexShrink: 0,
    }}>
      {/* Green dot — live */}
      <span style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: '#22c55e',
        flexShrink: 0,
      }} />
      {/* URL */}
      <span style={{
        fontSize: 11,
        color: '#64748b',
        fontFamily: 'ui-monospace, "SF Mono", Monaco, Menlo, monospace',
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {preview.url}
      </span>
      <button
        type="button"
        onClick={onToggleSelection}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 24,
          paddingTop: 0,
          paddingRight: 9,
          paddingBottom: 0,
          paddingLeft: 9,
          borderRadius: 999,
          border: selectionEnabled ? '1px solid rgba(37,99,235,0.28)' : '1px solid rgba(148,163,184,0.18)',
          background: selectionEnabled ? 'rgba(37,99,235,0.08)' : 'rgba(255,255,255,0.82)',
          color: selectionEnabled ? '#1d4ed8' : '#475569',
          cursor: 'pointer',
          fontSize: 11,
          fontWeight: 600,
          flexShrink: 0,
        }}
        title={selectionEnabled ? 'Element selection is active' : 'Select an element in the preview'}
      >
        <Crosshair size={12} />
        Select
      </button>
      {/* Refresh */}
      <button
        type="button"
        onClick={onRefresh}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          border: 'none',
          background: 'transparent',
          color: '#64748b',
          cursor: 'pointer',
          borderRadius: 4,
          fontSize: 14,
        }}
        title="Refresh"
      >
        ↻
      </button>
      {/* Close */}
      <button
        type="button"
        onClick={onClose}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          border: 'none',
          background: 'transparent',
          color: '#64748b',
          cursor: 'pointer',
          borderRadius: 4,
          fontSize: 14,
        }}
        title="Close preview"
      >
        ✕
      </button>
    </div>
  );
}

/* ── Workspace Chat Pane ── */

function workspaceToolLabel(toolName: string, args?: Record<string, unknown>) {
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

function buildWorkspaceThinkingStep(tool: MobileTranscriptToolCall): MobileTranscriptThinkingStep {
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

function upsertWorkspaceToolCall(
  previous: MobileTranscriptToolCall[],
  next: MobileTranscriptToolCall,
): MobileTranscriptToolCall[] {
  const existingIndex = previous.findIndex((tool) => tool.name === next.name);
  if (existingIndex >= 0) {
    return previous.map((tool, index) => (index === existingIndex ? { ...tool, ...next, status: next.status ?? tool.status } : tool));
  }
  return [...previous, next];
}

function transcriptToolSignature(entry: MobileTranscriptEntry) {
  return (entry.toolCalls ?? [])
    .map((tool) => `${tool.name}:${JSON.stringify(tool.args ?? {})}`)
    .join('|');
}

function mergeTranscriptEntries(current: MobileTranscriptEntry[], incoming: MobileTranscriptEntry[]) {
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
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return [...mergedIncoming, ...trailingLocal];
}

const WorkspaceChatPane = memo(function WorkspaceChatPane({
  tab,
  active,
  onUpdateMessages,
  onUpdateSessionKey,
  onRunInTerminal,
  onSelectModel,
  onConsumeDraftInjection,
  onLinkedIssueChange,
  onSaveCheckpoint,
  onRestoreLatestCheckpoint,
}: {
  tab: TerminalTab;
  active: boolean;
  onUpdateMessages: (tabId: string, messages: MobileTranscriptEntry[]) => void;
  onUpdateSessionKey: (tabId: string, sessionKey: string) => void;
  onRunInTerminal?: (command: string) => void;
  onSelectModel: (tabId: string, modelId: string) => void;
  onConsumeDraftInjection: (tabId: string, injectionId: string) => void;
  onLinkedIssueChange: (tabId: string, issue: LinkedIssueRef | null) => void;
  onSaveCheckpoint: (tabId: string) => void;
  onRestoreLatestCheckpoint: (tabId: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [queuedContextCards, setQueuedContextCards] = useState<QueuedContextCard[]>([]);
  const [liveAssistantId, setLiveAssistantId] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [activeToolCalls, setActiveToolCalls] = useState<MobileTranscriptToolCall[]>([]);
  const [activeThinking, setActiveThinking] = useState<{ steps: MobileTranscriptThinkingStep[]; thinking: string } | null>(null);
  const [streamMeta, setStreamMeta] = useState<{
    tokens?: { input: number; output: number };
    costUsd?: number;
    sources?: MobileTranscriptSource[];
    recalledFacts?: number;
    thinkingDurationMs?: number;
  }>({});
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [issuePickerOpen, setIssuePickerOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const liveToolCallsRef = useRef<MobileTranscriptToolCall[]>([]);
  const messagesRef = useRef<MobileTranscriptEntry[]>([]);
  const stickToBottomRef = useRef(true);
  const handledDraftInjectionRef = useRef<string | null>(null);
  const messages = useMemo(() => tab.chatMessages ?? [], [tab.chatMessages]);
  const tabId = tab.id;
  const chatRuntime = tab.chatRuntime;
  const chatSessionKey = tab.chatSessionKey;
  const normalizedSessionKey = useMemo(
    () => normalizeWorkspaceChatSessionKey(chatRuntime, chatSessionKey),
    [chatRuntime, chatSessionKey],
  );
  const transportSessionId = useMemo(
    () => runtimeTransportSessionId(chatRuntime, chatSessionKey),
    [chatRuntime, chatSessionKey],
  );
  const chatModel = tab.chatModel;
  const linkedIssue = tab.linkedIssue ?? null;
  const runtimeLabels = useMemo(
    () => ({ 'codex': 'Codex', 'claude-code': 'Claude Code' } as const),
    [],
  );
  const availableModels = useMemo(
    () => chatRuntime === 'claude-code' ? CLAUDE_CLI_MODELS : CODEX_CLI_MODELS,
    [chatRuntime],
  );
  const selectedModel = useMemo(
    () => availableModels.find((model) => model.id === chatModel) ?? availableModels[0],
    [availableModels, chatModel],
  );

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const scrollToBottom = useCallback((force = false) => {
    if (!scrollRef.current) return;
    if (!force && !stickToBottomRef.current) return;
    setShowScrollToBottom(false);
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, []);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distFromBottom < 80;
    setShowScrollToBottom(distFromBottom >= 80);
  }, []);

  const fetchTranscript = useCallback(async () => {
    if (!chatRuntime || !normalizedSessionKey) return;
    if (chatRuntime !== 'codex' && chatRuntime !== 'claude-code') return;
    try {
      const endpoint = `/api/mobile/history?sessionKey=${encodeURIComponent(normalizedSessionKey)}&limit=80`;
      const res = await fetch(endpoint);
      if (!res.ok) return;
      const data = await res.json() as { transcript?: MobileTranscriptEntry[] };
      if (Array.isArray(data.transcript)) {
        onUpdateMessages(tabId, mergeTranscriptEntries(messagesRef.current, data.transcript));
        requestAnimationFrame(() => scrollToBottom(true));
      }
    } catch {
      // silent
    }
  }, [chatRuntime, normalizedSessionKey, onUpdateMessages, scrollToBottom, tabId]);

  useEffect(() => {
    if (!active) return;
    void fetchTranscript();
  }, [active, fetchTranscript]);

  useEffect(() => {
    if (!active || !normalizedSessionKey) return;
    const id = setInterval(() => { void fetchTranscript(); }, 5_000);
    return () => clearInterval(id);
  }, [active, fetchTranscript, normalizedSessionKey]);

  // Fast retry for new runtime session tabs — polls every 1.5s until transcript arrives
  const isAgentTab = isAgentRuntimeTab(tab);
  const isRuntimeBound = Boolean(normalizedSessionKey && isAgentTab);
  useEffect(() => {
    if (!active || !isRuntimeBound) return;
    if (messagesRef.current.length > 0) return;

    const id = setInterval(() => {
      if (messagesRef.current.length > 0) {
        clearInterval(id);
        return;
      }
      void fetchTranscript();
    }, 1_500);

    const timeout = setTimeout(() => clearInterval(id), 60_000);
    return () => { clearInterval(id); clearTimeout(timeout); };
  }, [active, isRuntimeBound, fetchTranscript]);

  const sendText = useCallback(async (inputText: string, options?: { baseMessages?: MobileTranscriptEntry[] }) => {
    const text = inputText.trim();
    if (!text || sending) return;
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    setSending(true);
    setAgentRunning(true);
    setStreamingText('');
    liveToolCallsRef.current = [];
    setActiveToolCalls([]);
    setActiveThinking({
      steps: [{
        type: 'thinking',
        label: 'Reasoning through the problem...',
        status: 'active',
      }],
      thinking: '',
    });
    setStreamMeta({});

    const userMsg: MobileTranscriptEntry = {
      id: `msg-${Date.now()}-user`,
      role: 'user',
      text,
      timestamp: Date.now(),
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    const baseMessages = options?.baseMessages ?? messagesRef.current;
    const updated = [...baseMessages, userMsg];
    onUpdateMessages(tabId, updated);
    scrollToBottom(true);

    try {
      const composedMessage = [buildLinkedIssueContext(linkedIssue), text].filter(Boolean).join('\n\n');
      let endpoint = '';
      let body: Record<string, unknown> = {};

      if (chatRuntime === 'claude-code') {
        endpoint = '/api/claude-code/send';
        body = {
          message: composedMessage,
          sessionId: transportSessionId,
          cwd: tab.repo?.localPath,
          model: selectedModel?.id,
          continueLatest: tab.chatContinueLatest !== false,
        };
      } else if (chatRuntime === 'codex') {
        if (isOwnedCodexRuntimeSession(normalizedSessionKey)) {
          const res = await fetch('/api/runtime/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'steer',
              surfaceId: normalizedSessionKey,
              message: composedMessage,
            }),
          });
          const payload = await res.json().catch(() => null) as { ok?: boolean; note?: string; error?: string } | null;
          if (!res.ok || payload?.ok === false) {
            const errorText = payload?.error ?? payload?.note ?? res.statusText;
            onUpdateMessages(tabId, [
              ...updated,
              {
                id: `msg-${Date.now()}-error`,
                role: 'assistant',
                text: `Error: ${errorText || 'Failed to send'}`,
                timestamp: Date.now(),
                timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              },
            ]);
            return;
          }
          window.setTimeout(() => { void fetchTranscript(); }, 800);
          return;
        }
        endpoint = '/api/codex/send';
        body = {
          message: composedMessage,
          threadId: transportSessionId,
          cwd: tab.repo?.localPath,
          model: selectedModel?.id,
        };
      } else {
        throw new Error('Unsupported workspace runtime session.');
      }

      const assistantId = `msg-${Date.now()}-assistant`;
      let nextTranscript: MobileTranscriptEntry[] = [
        ...updated,
        {
          id: assistantId,
          role: 'assistant',
          text: '',
          timestamp: Date.now(),
          timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          toolCalls: [],
        },
      ];
      setLiveAssistantId(assistantId);
      onUpdateMessages(tabId, nextTranscript);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => res.statusText);
        onUpdateMessages(
          tabId,
          nextTranscript.map((entry) => entry.id === assistantId ? { ...entry, text: `Error: ${errText || res.statusText}` } : entry),
        );
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let buffer = '';
      let thinkingText = '';
      const thinkingSteps: MobileTranscriptThinkingStep[] = [{
        type: 'thinking',
        label: 'Reasoning through the problem...',
        status: 'active',
      }];
      const thinkingStartTime = Date.now();
      let isThinking = true;
      let tokens: { input: number; output: number } | undefined;
      let costUsd: number | undefined;
      let recalledFacts = 0;
      const sources: MobileTranscriptSource[] = [];

      const pushThinkingState = (forceLive = false) => {
        if (thinkingSteps.length === 0 && !thinkingText) {
          setActiveThinking(null);
          return;
        }
        const steps = thinkingSteps.map((step) => ({ ...step }));
        setActiveThinking({
          steps: forceLive ? steps : steps.map((step) => ({ ...step, status: step.status === 'active' ? 'complete' : step.status })),
          thinking: thinkingText,
        });
      };

      const updateAssistantEntry = () => {
        const thinkingDurationMs = (thinkingSteps.length > 0 || thinkingText)
          ? Date.now() - thinkingStartTime
          : undefined;
        const uniqueSources = sources.filter((source, index, current) => current.findIndex((candidate) => (
          candidate.title === source.title && candidate.url === source.url && candidate.path === source.path
        )) === index);
        setStreamMeta({
          tokens,
          costUsd,
          sources: uniqueSources.length > 0 ? uniqueSources : undefined,
          recalledFacts: recalledFacts > 0 ? recalledFacts : undefined,
          thinkingDurationMs,
        });
        nextTranscript = nextTranscript.map((entry) => (
          entry.id === assistantId
            ? {
                ...entry,
                text: accumulated,
                model: selectedModel.label,
                tokens,
                costUsd,
                sources: uniqueSources.length > 0 ? uniqueSources : undefined,
                recalledFacts: recalledFacts > 0 ? recalledFacts : undefined,
                toolCalls: liveToolCallsRef.current.length > 0 ? [...liveToolCallsRef.current] : undefined,
                thinking: thinkingText || undefined,
                thinkingSteps: thinkingSteps.length > 0 ? thinkingSteps.map((step) => ({ ...step, status: step.status === 'active' ? 'complete' : step.status })) : undefined,
                thinkingDurationMs,
              }
            : entry
        ));
        onUpdateMessages(tabId, nextTranscript);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6)) as {
              type: string;
              text?: string;
              name?: string;
              status?: 'calling' | 'running' | 'done';
              args?: Record<string, unknown>;
              preview?: string;
              sessionId?: string;
              threadId?: string;
              inputTokens?: number;
              outputTokens?: number;
              costUsd?: number;
              factCount?: number;
              sources?: MobileTranscriptSource[];
            };

            if ((event.type === 'delta' || event.type === 'content') && event.text) {
              if (isThinking) {
                isThinking = false;
                thinkingSteps.forEach((step) => {
                  if (step.status === 'active') step.status = 'complete';
                });
                pushThinkingState(true);
              }
              accumulated += event.text;
              setStreamingText(accumulated);
              updateAssistantEntry();
              scrollToBottom(false);
            }

            if (event.type === 'thinking') {
              if (!isThinking) {
                isThinking = true;
                thinkingSteps.push({
                  type: 'thinking',
                  label: 'Reasoning through the problem...',
                  status: 'active',
                });
              }
              if (event.text) {
                thinkingText += event.text;
                const lines = event.text.split('\n').filter((candidate) => candidate.trim());
                for (const candidate of lines) {
                  const trimmed = candidate.trim();
                  if (trimmed.length > 10 && (
                    trimmed.startsWith('I need to')
                    || trimmed.startsWith('Let me')
                    || trimmed.startsWith('First,')
                    || trimmed.startsWith('Now')
                    || trimmed.startsWith('The ')
                    || trimmed.startsWith('This ')
                  )) {
                    const active = thinkingSteps.find((step) => step.status === 'active');
                    if (active) {
                      active.label = trimmed.slice(0, 60) + (trimmed.length > 60 ? '...' : '');
                    }
                  }
                }
              }
              pushThinkingState(true);
            }

            if ((event.type === 'tool' || event.type === 'tool_call') && event.name) {
              const nextTool: MobileTranscriptToolCall = {
                name: event.name,
                status: event.status ?? 'running',
                args: event.args,
              };
              const nextTools = upsertWorkspaceToolCall(liveToolCallsRef.current, nextTool);
              liveToolCallsRef.current = nextTools;
              setActiveToolCalls(nextTools);
              const nextStep = buildWorkspaceThinkingStep(nextTool);
              const existingStep = thinkingSteps.find((step) => step.label === nextStep.label);
              if (existingStep) {
                existingStep.status = nextStep.status;
                existingStep.detail = nextStep.detail;
              } else {
                thinkingSteps.push(nextStep);
              }
              pushThinkingState(true);
              updateAssistantEntry();
            }

            if (event.type === 'tool_result') {
              const lastTool = event.name
                ? liveToolCallsRef.current.find((tool) => tool.name === event.name)
                : liveToolCallsRef.current[liveToolCallsRef.current.length - 1];
              if (lastTool) {
                const nextTools = upsertWorkspaceToolCall(liveToolCallsRef.current, {
                  ...lastTool,
                  status: 'done',
                  preview: event.preview ?? lastTool.preview,
                });
                liveToolCallsRef.current = nextTools;
                setActiveToolCalls(nextTools);
              }
              const toolStep = [...thinkingSteps].reverse().find((step) => step.status === 'active' && step.type !== 'thinking');
              if (toolStep) toolStep.status = 'complete';
              pushThinkingState(true);
              updateAssistantEntry();
            }

            if (event.type === 'usage') {
              tokens = typeof event.inputTokens === 'number' || typeof event.outputTokens === 'number'
                ? { input: event.inputTokens ?? 0, output: event.outputTokens ?? 0 }
                : tokens;
              if (typeof event.costUsd === 'number') {
                costUsd = event.costUsd;
              }
              updateAssistantEntry();
            }

            if (event.type === 'memory_recall') {
              recalledFacts = event.factCount ?? 0;
              if (recalledFacts > 0) {
                thinkingSteps.push({
                  type: 'search',
                  label: `Recalled ${recalledFacts} memor${recalledFacts === 1 ? 'y' : 'ies'} from Cortex`,
                  status: 'complete',
                });
                pushThinkingState(true);
                updateAssistantEntry();
              }
            }

            if (event.type === 'sources' && Array.isArray(event.sources)) {
              sources.splice(0, sources.length, ...event.sources);
              updateAssistantEntry();
            }

            if (event.sessionId && chatRuntime === 'claude-code') {
              onUpdateSessionKey(tabId, event.sessionId);
            }
            if (event.threadId && chatRuntime === 'codex') {
              onUpdateSessionKey(tabId, event.threadId);
            }

            if (event.type === 'done' || event.type === 'close') {
              if (typeof event.inputTokens === 'number' || typeof event.outputTokens === 'number') {
                tokens = {
                  input: event.inputTokens ?? tokens?.input ?? 0,
                  output: event.outputTokens ?? tokens?.output ?? 0,
                };
              }
              if (typeof event.costUsd === 'number') {
                costUsd = event.costUsd;
              }
              if (event.text && !accumulated) {
                accumulated = event.text;
                setStreamingText(accumulated);
              }
              const settledTools = liveToolCallsRef.current.map((tool) => ({ ...tool, status: 'done' as const }));
              if (settledTools.length > 0) {
                liveToolCallsRef.current = settledTools;
                setActiveToolCalls(settledTools);
              }
              thinkingSteps.forEach((step) => {
                if (step.status === 'active') step.status = 'complete';
              });
              pushThinkingState(false);
              updateAssistantEntry();
            }

            if (event.type === 'error' && event.text) {
              accumulated += `\n⚠️ ${event.text}`;
              updateAssistantEntry();
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }

      if (!accumulated) {
        onUpdateMessages(
          tabId,
          nextTranscript.map((entry) => entry.id === assistantId ? { ...entry, text: 'No response received' } : entry),
        );
      }
    } catch (err) {
      onUpdateMessages(tabId, [
        ...updated,
        {
          id: `msg-${Date.now()}-error`,
          role: 'assistant',
          text: `Error: ${err instanceof Error ? err.message : 'Failed to send'}`,
          timestamp: Date.now(),
          timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setSending(false);
      setAgentRunning(false);
      setLiveAssistantId(null);
      setStreamingText('');
      setActiveThinking(null);
      setStreamMeta({});
      setTimeout(() => { void fetchTranscript(); }, 400);
    }
  }, [chatRuntime, fetchTranscript, linkedIssue, normalizedSessionKey, onUpdateMessages, onUpdateSessionKey, scrollToBottom, selectedModel, sending, tab.chatContinueLatest, tab.repo?.localPath, tabId, transportSessionId]);

  const handleSend = useCallback(async () => {
    const baseDraft = draft.trim();
    if ((!baseDraft && queuedContextCards.length === 0) || sending) return;
    const text = [
      ...queuedContextCards.map((card) => card.text.trim()).filter(Boolean),
      baseDraft,
    ].filter(Boolean).join('\n\n');
    setQueuedContextCards([]);
    setDraft('');
    await sendText(text);
  }, [draft, queuedContextCards, sendText, sending]);

  useEffect(() => {
    const injection = tab.chatDraftInjection;
    if (!injection?.id) return;
    if (handledDraftInjectionRef.current === injection.id) return;
    handledDraftInjectionRef.current = injection.id;
    stickToBottomRef.current = true;

    if (injection.autoSend) {
      setDraft('');
      void sendText(injection.text);
      requestAnimationFrame(() => composeRef.current?.focus());
    } else {
      setQueuedContextCards((prev) => {
        if (prev.some((card) => card.id === injection.id)) return prev;
        return [...prev, buildQueuedContextCard(injection)];
      });
      requestAnimationFrame(() => composeRef.current?.focus());
    }

    onConsumeDraftInjection(tabId, injection.id);
  }, [onConsumeDraftInjection, sendText, tab.chatDraftInjection, tabId]);

  const runtimeLabel = runtimeLabels[tab.chatRuntime ?? 'codex'];
  const llmMessages = useMemo<LLMMessage[]>(
    () => messages.map((message) => ({
      id: message.id,
      role: message.role === 'system' || message.role === 'tool' ? 'assistant' : message.role,
      content: message.text,
      model: message.model ?? (message.role === 'assistant' ? selectedModel?.label : undefined),
      timestamp: message.timestamp ?? Date.now(),
      tokens: message.tokens,
      costUsd: message.costUsd,
      toolCalls: message.toolCalls?.map((tool) => ({
        name: tool.name,
        status: tool.status ?? 'done',
        args: tool.args,
        preview: tool.preview,
      })),
      sources: message.sources,
      thinking: message.thinking,
      thinkingSteps: message.thinkingSteps,
      thinkingDurationMs: message.thinkingDurationMs,
      recalledFacts: message.recalledFacts,
      isError: /^error:/i.test(message.text.trim()),
    })),
    [messages, selectedModel],
  );

  const visibleMessages = useMemo(
    () => (agentRunning && liveAssistantId ? llmMessages.filter((message) => message.id !== liveAssistantId) : llmMessages),
    [agentRunning, liveAssistantId, llmMessages],
  );

  useEffect(() => {
    if (!scrollRef.current) return;
    if (visibleMessages.length === 0 && !streamingText && activeToolCalls.length === 0) return;
    scrollToBottom();
  }, [activeToolCalls.length, scrollToBottom, streamingText, visibleMessages.length]);

  const handleRetry = useCallback((messageId: string) => {
    const messageIndex = messagesRef.current.findIndex((entry) => entry.id === messageId);
    if (messageIndex < 0) return;
    const previousMessages = messagesRef.current.slice(0, messageIndex);
    const lastUser = [...previousMessages].reverse().find((entry) => entry.role === 'user');
    if (!lastUser) return;
    const baseMessages = previousMessages.filter((entry) => entry.id !== lastUser.id);
    onUpdateMessages(tabId, baseMessages);
    void sendText(lastUser.text, { baseMessages });
  }, [onUpdateMessages, sendText, tabId]);

  const handleEdit = useCallback((messageId: string, content: string) => {
    const messageIndex = messagesRef.current.findIndex((entry) => entry.id === messageId);
    if (messageIndex < 0) return;
    setDraft(content);
    onUpdateMessages(tabId, messagesRef.current.slice(0, messageIndex));
    requestAnimationFrame(() => composeRef.current?.focus());
  }, [onUpdateMessages, tabId]);

  const handleDelete = useCallback((messageId: string) => {
    const current = messagesRef.current;
    const messageIndex = current.findIndex((entry) => entry.id === messageId);
    if (messageIndex < 0) return;
    const message = current[messageIndex];
    if (!message) return;
    if (message.role === 'user' && current[messageIndex + 1]?.role === 'assistant') {
      onUpdateMessages(tabId, current.filter((_, idx) => idx !== messageIndex && idx !== messageIndex + 1));
      return;
    }
    if (message.role === 'assistant' && messageIndex > 0 && current[messageIndex - 1]?.role === 'user') {
      onUpdateMessages(tabId, current.filter((_, idx) => idx !== messageIndex && idx !== messageIndex - 1));
      return;
    }
    onUpdateMessages(tabId, current.filter((_, idx) => idx !== messageIndex));
  }, [onUpdateMessages, tabId]);

  const handleRemoveQueuedContext = useCallback((contextId: string) => {
    setQueuedContextCards((prev) => prev.filter((card) => card.id !== contextId));
  }, []);

  const canSend = draft.trim().length > 0 || queuedContextCards.length > 0;

  return (
    <div data-vibrancy-passthrough="" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--t-bg-gradient)', position: 'relative' }}>
      <div
        ref={scrollRef}
        className="cortex-themed-scroll"
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          paddingTop: llmMessages.length === 0 && !agentRunning ? 0 : 24,
          paddingBottom: 24,
          paddingLeft: 24,
          paddingRight: 24,
          background: 'transparent',
        }}
      >
        {visibleMessages.length === 0 && !agentRunning ? (
          isAgentTab ? (
          /* Agent-runtime tab — waiting for agent transcript */
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: 16,
            animation: 'llmFadeIn 400ms ease-out',
          }}>
            <div style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              background: 'rgba(37, 99, 235, 0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" />
              </svg>
            </div>
            <div style={{
              fontSize: 15,
              fontWeight: 600,
              color: 'var(--t-text)',
              letterSpacing: '-0.01em',
            }}>
              Connecting to agent...
            </div>
            <div style={{
              fontSize: 12,
              color: 'var(--t-text-secondary)',
              textAlign: 'center',
              maxWidth: 320,
              lineHeight: 1.5,
            }}>
              Waiting for transcript from the {runtimeLabel} session. You can type a message below to steer the agent.
            </div>
          </div>
          ) : (
          /* Empty LLM chat — greeting state */
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: 32,
            animation: 'llmFadeIn 400ms ease-out',
          }}>
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
            }}>
              <div style={{
                width: 48,
                height: 48,
                borderRadius: 14,
                background: `linear-gradient(135deg, ${THEME_ACCENT} 0%, #8b5cf6 100%)`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: `0 4px 16px ${THEME_ACCENT_RING}`,
              }}>
                <MessageSquare size={24} style={{ color: 'white' }} />
              </div>
              <div style={{
                fontSize: 24,
                fontWeight: 600,
                color: 'var(--t-text-strong)',
                letterSpacing: '-0.02em',
              }}>
                {(() => {
                  const h = new Date().getHours();
                  const greeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
                  return `${greeting}. What can I help you build?`;
                })()}
              </div>
              <div style={{
                fontSize: 14,
                color: 'var(--t-text-muted)',
                textAlign: 'center',
                maxWidth: 420,
                lineHeight: '1.5',
              }}>
                Chat with {selectedModel.label} — scoped to this {runtimeLabel} lane{tab.repo ? ` in ${tab.repo.name}` : ''}.
              </div>
            </div>

            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 10,
              maxWidth: 560,
              width: '100%',
            }}>
              {CLI_SUGGESTED_PROMPTS.map((prompt, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setDraft(prompt.text);
                    setTimeout(() => composeRef.current?.focus(), 50);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    paddingTop: 14,
                    paddingBottom: 14,
                    paddingLeft: 14,
                    paddingRight: 14,
                    background: THEME_BG_CARD,
                    border: '1px solid var(--t-panel-border)',
                    borderRadius: 12,
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 150ms ease',
                    animation: `llmFadeIn 400ms ease-out ${100 + i * 50}ms both`,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = THEME_ACCENT_BORDER;
                    e.currentTarget.style.background = THEME_ACCENT_SOFT;
                    e.currentTarget.style.transform = 'translateY(-1px)';
                    e.currentTarget.style.boxShadow = `0 2px 8px ${THEME_ACCENT_RING}`;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'var(--t-panel-border)';
                    e.currentTarget.style.background = THEME_BG_CARD;
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                >
                  <span style={{ fontSize: 18, lineHeight: '1', flexShrink: 0 }}>{prompt.icon}</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text)', lineHeight: '1.3' }}>
                      {prompt.text}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--t-text-muted)', lineHeight: '1.4' }}>
                      {prompt.description}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
          )
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 720, marginLeft: 'auto', marginRight: 'auto' }}>
            {visibleMessages.map((message, index) => (
              <MessageBubble
                key={message.id}
                message={message}
                isLast={index === visibleMessages.length - 1 && !sending}
                onRetry={message.role === 'assistant' ? () => handleRetry(message.id) : undefined}
                onEdit={message.role === 'user' ? (content) => handleEdit(message.id, content) : undefined}
                onDelete={() => handleDelete(message.id)}
                onRunInTerminal={onRunInTerminal}
              />
            ))}
            {agentRunning && activeThinking && activeThinking.steps.length > 0 ? (
              <ChainOfThought
                steps={activeThinking.steps}
                thinking={activeThinking.thinking}
                durationMs={streamMeta.thinkingDurationMs}
                isLive
              />
            ) : null}
            {agentRunning ? (
              <MessageBubble
                message={{
                  id: `stream:${tabId}`,
                  role: 'assistant',
                  content: streamingText || 'Thinking…',
                  model: selectedModel.label,
                  timestamp: Date.now(),
                  tokens: streamMeta.tokens,
                  costUsd: streamMeta.costUsd,
                  sources: streamMeta.sources,
                  recalledFacts: streamMeta.recalledFacts,
                  toolCalls: activeToolCalls.map((tool) => ({
                    name: tool.name,
                    status: tool.status ?? 'running',
                    args: tool.args,
                    preview: tool.preview,
                  })),
                }}
                isLast
                onRunInTerminal={onRunInTerminal}
              />
            ) : null}
          </div>
        )}
      </div>

      {showScrollToBottom && (llmMessages.length > 0 || agentRunning) ? (
        <div
          style={{
            position: 'absolute',
            right: 30,
            bottom: 104,
            zIndex: 40,
            animation: 'llmFadeIn 150ms ease-out',
          }}
        >
          <button
            type="button"
            onClick={() => {
              scrollToBottom(true);
              stickToBottomRef.current = true;
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              minHeight: 34,
              padding: '7px 12px',
              borderRadius: 999,
              border: `1px solid ${THEME_ACCENT_BORDER}`,
              background: THEME_PANEL_GLASS,
              color: THEME_ACCENT,
              boxShadow: `0 12px 28px ${THEME_ACCENT_RING}`,
              backdropFilter: 'blur(18px)',
              WebkitBackdropFilter: 'blur(18px)',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 700,
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            <ArrowDown size={13} />
            Bottom messages
          </button>
        </div>
      ) : null}

      <div style={{
        paddingTop: 12,
        paddingBottom: 16,
        paddingLeft: 24,
        paddingRight: 24,
        borderTop: '1px solid var(--t-divider)',
        background: 'transparent',
      }}>
        <div style={{
          maxWidth: 720,
          marginLeft: 'auto',
          marginRight: 'auto',
          border: '1px solid var(--t-panel-border)',
          borderRadius: 18,
          background: THEME_PANEL_GLASS,
          transition: 'border-color 200ms, box-shadow 200ms',
          overflow: 'hidden',
        }}>
          {queuedContextCards.length > 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                paddingTop: 14,
                paddingRight: 14,
                paddingBottom: 0,
                paddingLeft: 14,
                borderBottom: '1px solid var(--t-divider-subtle)',
              }}
            >
              {queuedContextCards.map((card) => (
                <div
                  key={card.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '8px 10px',
                    borderRadius: 12,
                    border: '1px solid var(--t-panel-border)',
                    background: THEME_BG_CARD,
                  }}
                >
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 28,
                      height: 28,
                      borderRadius: 9,
                      background: THEME_ACCENT_SOFT,
                      color: THEME_ACCENT,
                      flexShrink: 0,
                    }}
                  >
                    <MessageSquare size={14} />
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: THEME_ACCENT }}>
                      Staged Context
                    </div>
                    <div style={{ marginTop: 3, fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>
                      {card.title}
                    </div>
                    {card.meta.length > 0 ? (
                      <div style={{ marginTop: 3, display: 'flex', gap: 7, flexWrap: 'wrap', fontSize: 10, color: 'var(--t-text-muted)' }}>
                        {card.meta.slice(0, 2).map((entry) => (
                          <span key={entry}>{entry}</span>
                        ))}
                      </div>
                    ) : null}
                    {card.preview ? (
                      <div style={{ marginTop: 5, fontSize: 11, lineHeight: 1.45, color: 'var(--t-text-secondary)' }}>
                        {card.preview.length > 120 ? `${card.preview.slice(0, 117).trimEnd()}…` : card.preview}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveQueuedContext(card.id)}
                    title="Remove staged context"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 28,
                      height: 28,
                      borderRadius: 10,
                      border: '1px solid var(--t-btn-secondary-border)',
                      background: 'var(--t-btn-secondary-bg)',
                      color: 'var(--t-text)',
                      cursor: 'pointer',
                      flexShrink: 0,
                      boxShadow: '0 1px 2px rgba(15, 23, 42, 0.06)',
                    }}
                  >
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 14,
                        height: 14,
                        lineHeight: 0,
                        color: 'var(--t-text-secondary)',
                      }}
                    >
                      <X size={13} />
                    </span>
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div style={{
            paddingTop: 14,
            paddingBottom: 8,
            paddingLeft: 18,
            paddingRight: 18,
          }}>
            <textarea
              ref={composeRef}
              name="workspaceComposeMessage"
              aria-label={`Message ${runtimeLabel}`}
              value={draft}
              onChange={(e) => {
                setDraft(e.currentTarget.value);
                e.currentTarget.style.height = 'auto';
                e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 200)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={isAgentTab ? `Steer this ${runtimeLabel} agent...` : `Message ${runtimeLabel}...`}
              rows={1}
              style={{
                width: '100%',
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: 'var(--t-text)',
                fontSize: 14,
                fontFamily: '-apple-system, system-ui, sans-serif',
                lineHeight: '1.5',
                resize: 'none',
                minHeight: 24,
                maxHeight: 200,
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: 4,
            paddingBottom: 10,
            paddingLeft: 14,
            paddingRight: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                disabled
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--t-text-faint)',
                  cursor: 'default',
                }}
                title="Attachments coming soon"
              >
                <Plus size={16} />
              </button>
              <span style={{
                fontSize: 10,
                color: 'var(--t-text-faint)',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}>
                CLI session
              </span>
              <button
                type="button"
                onClick={() => setIssuePickerOpen(true)}
                title={linkedIssue ? `${linkedIssue.title}` : 'Link a GitHub issue to this chat'}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  minHeight: 28,
                  padding: '0 10px',
                  borderRadius: 999,
                  border: linkedIssue ? `1px solid ${THEME_ACCENT_BORDER}` : '1px solid var(--t-panel-border)',
                  background: linkedIssue
                    ? THEME_ACCENT_SOFT
                    : THEME_BG_CARD,
                  color: linkedIssue ? THEME_ACCENT : 'var(--t-text-secondary)',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  whiteSpace: 'nowrap',
                }}
              >
                <AlertCircle size={13} />
                {linkedIssue ? `Issue #${linkedIssue.number}` : 'Link issue'}
              </button>
              <button
                type="button"
                onClick={() => onSaveCheckpoint(tabId)}
                disabled={messages.length === 0}
                title={messages.length === 0 ? 'Checkpoint becomes available once this chat has transcript history' : 'Save a safe checkpoint from this chat'}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  minHeight: 28,
                  padding: '0 10px',
                  borderRadius: 999,
                  border: '1px solid var(--t-panel-border)',
                  background: THEME_BG_CARD,
                  color: messages.length === 0 ? 'var(--t-text-faint)' : 'var(--t-text-secondary)',
                  cursor: messages.length === 0 ? 'default' : 'pointer',
                  fontSize: 11,
                  fontStyle: 'italic',
                  fontWeight: 700,
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  whiteSpace: 'nowrap',
                }}
              >
                <AlertCircle size={13} />
                Checkpoint
              </button>
              {tab.chatCheckpoints && tab.chatCheckpoints.length > 0 ? (
                <button
                  type="button"
                  onClick={() => onRestoreLatestCheckpoint(tabId)}
                  title={`Restore from the latest checkpoint (${tab.chatCheckpoints[0]?.label})`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    minHeight: 28,
                    padding: '0 10px',
                    borderRadius: 999,
                    border: `1px solid ${THEME_ACCENT_BORDER}`,
                    background: THEME_ACCENT_SOFT,
                    color: THEME_ACCENT,
                    cursor: 'pointer',
                    fontSize: 11,
                    fontStyle: 'italic',
                    fontWeight: 700,
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <RotateCcw size={13} />
                  Restore latest
                </button>
              ) : null}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <WorkspaceCliModelPicker
                selected={selectedModel}
                models={availableModels}
                disabled={sending}
                onSelect={(modelId) => onSelectModel(tabId, modelId)}
              />
              <span style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: agentRunning ? '#22c55e' : 'var(--t-divider-strong)',
              }} />

              {agentRunning ? (
                <button
                  type="button"
                  disabled
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 32,
                    height: 32,
                    border: 'none',
                    borderRadius: 10,
                    background: '#ef4444',
                    color: '#ffffff',
                    cursor: 'default',
                    flexShrink: 0,
                  }}
                >
                  <Square size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={!canSend || sending}
                  title="Send message (Enter)"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 32,
                    height: 32,
                    border: 'none',
                    borderRadius: 10,
                    background: canSend ? THEME_ACCENT : 'var(--t-divider-strong)',
                    color: canSend ? '#ffffff' : 'var(--t-text-faint)',
                    cursor: canSend ? 'pointer' : 'default',
                    flexShrink: 0,
                    transition: 'all 150ms',
                  }}
                >
                  <ArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <IssueLinkPickerModal
        open={issuePickerOpen}
        onClose={() => setIssuePickerOpen(false)}
        value={linkedIssue}
        preferredRepo={tab.repo ?? null}
        onSelect={(issue) => onLinkedIssueChange(tabId, issue)}
        onClear={() => onLinkedIssueChange(tabId, null)}
      />
    </div>
  );
});

const PreviewPane = memo(function PreviewPane({ previews, onElementSelect, onRefresh, onClose }: {
  previews: LocalhostPreview[];
  onElementSelect?: (selection: PreviewSelectionPayload) => void;
  onRefresh: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());
  const [selectionModes, setSelectionModes] = useState<Record<string, boolean>>({});

  const syncSelectionMode = useCallback((previewId: string, enabled: boolean) => {
    const iframe = iframeRefs.current.get(previewId);
    iframe?.contentWindow?.postMessage({
      source: PREVIEW_HOST_MESSAGE_SOURCE,
      type: 'selection-mode',
      enabled,
    }, window.location.origin);
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        source?: string;
        type?: string;
        enabled?: boolean;
        selection?: PreviewSelectionPayload;
      };
      if (!data || data.source !== PREVIEW_MESSAGE_SOURCE) return;

      const preview = previews.find((item) => iframeRefs.current.get(item.id)?.contentWindow === event.source);
      if (!preview) return;

      if (data.type === 'ready') {
        syncSelectionMode(preview.id, Boolean(selectionModes[preview.id]));
        return;
      }

      if (data.type === 'selection-mode') {
        setSelectionModes((prev) => ({ ...prev, [preview.id]: Boolean(data.enabled) }));
        return;
      }

      if (data.type === 'selection' && data.selection) {
        onElementSelect?.(data.selection);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onElementSelect, previews, selectionModes, syncSelectionMode]);

  if (previews.length === 0) return null;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'row',
      flex: 1,
      minHeight: 0,
      gap: 1,
      background: '#e2e8f0',
    }}>
      {previews.map((p) => (
        <div key={p.id} style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          background: '#ffffff',
        }}>
          <PreviewToolbar
            preview={p}
            selectionEnabled={Boolean(selectionModes[p.id])}
            onToggleSelection={() => {
              setSelectionModes((prev) => {
                const enabled = !prev[p.id];
                syncSelectionMode(p.id, enabled);
                return { ...prev, [p.id]: enabled };
              });
            }}
            onRefresh={() => {
              const iframe = iframeRefs.current.get(p.id);
              if (iframe) {
                // Force reload by resetting src
                const src = iframe.src;
                iframe.src = '';
                setTimeout(() => { iframe.src = src; }, 50);
              }
              onRefresh(p.id);
            }}
            onClose={() => onClose(p.id)}
          />
          <iframe
            ref={(el) => {
              if (el) iframeRefs.current.set(p.id, el);
              else iframeRefs.current.delete(p.id);
            }}
            src={`/api/panel/proxy?url=${encodeURIComponent(p.url.replace('0.0.0.0', 'localhost'))}`}
            title={`Preview ${p.url}`}
            onLoad={() => syncSelectionMode(p.id, Boolean(selectionModes[p.id]))}
            style={{
              flex: 1,
              border: 'none',
              width: '100%',
              background: '#ffffff',
            }}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        </div>
      ))}
    </div>
  );
});

/** Format elapsed time: 0s → 59s, 1m → 59m, 1h → 99h */
function parseWorkspaceTaskLabel(label: string) {
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

function inferWorkspaceTaskState(tab: TerminalTab) {
  const messages = tab.chatMessages ?? [];
  const latestAssistant = [...messages].reverse().find((entry) => entry.role === 'assistant' || entry.role === 'system');
  return deriveWorkflowStage({
    autoQueued: tab.chatDraftInjection?.autoSend ?? false,
    latestText: latestAssistant?.text ?? '',
    lastActivityAt: tab.lastActivity,
    hasMessages: messages.length > 0,
  });
}

function summarizeWorkspaceTabText(value?: string | null, maxWords = 3) {
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

function describeWorkspaceChatTab(tab: TerminalTab) {
  if (tab.kind !== 'chat' && tab.kind !== 'llm-chat') return null;
  const latestDraft = tab.kind === 'chat'
    ? (tab.chatDraftInjection?.text ?? null)
    : (tab.llmDraftInjection?.text ?? null);
  const fullSummary = (tab.kind === 'llm-chat'
    ? (tab.llmSummary ?? latestDraft ?? null)
    : (() => {
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
        return latestUser?.text ?? latestDraft ?? latestAssistant?.text ?? null;
      })()
  )?.replace(/\s+/g, ' ').trim() ?? null;
  const summary = summarizeWorkspaceTabText(fullSummary, 3);
  const repoLabel = tab.repo?.name ?? (tab.repo?.localPath ? tab.repo.localPath.split('/').pop() : null);
  const detailParts = tab.repo?.isWorktree
    ? [tab.repo.branch ?? null, repoLabel, tab.repo.worktreeStatus ?? 'workspace']
    : [tab.repo?.branch ?? null, repoLabel];
  return {
    fullSummary,
    summary,
    detail: detailParts.filter((value): value is string => Boolean(value)).join(' · ') || null,
  };
}

function workspaceTabPrimaryLabel(tab: TerminalTab) {
  if (tab.orchestrationPacket) {
    return laneDisplayTitle(tab.orchestrationPacket, tab.kind);
  }
  // Use explicit label if set (e.g., "Issue #303" from Activity Feed launch)
  // before falling back to generic "Ad hoc chat" defaults.
  if (tab.label && !/^ad\s*hoc/i.test(tab.label) && !/^chat-/.test(tab.label) && !/^terminal-/.test(tab.label)) {
    return tab.label;
  }
  if (tab.kind === 'llm-chat') {
    return adHocLaneTitle('llm-chat');
  }
  if (tab.kind === 'chat') {
    return adHocLaneTitle('chat');
  }
  if (tab.kind === 'terminal') {
    return adHocLaneTitle('terminal');
  }
  return tab.label;
}

function workspaceInspectorIcon(kind?: CanvasTab['kind']) {
  switch (kind) {
    case 'diff':
    case 'commit':
    case 'git-log':
      return <GitCommit size={12} style={{ color: '#f59e0b' }} />;
    case 'issue':
    case 'ci':
      return <AlertCircle size={12} style={{ color: '#f59e0b' }} />;
    case 'pr':
      return <CheckCircle2 size={12} style={{ color: THEME_ACCENT }} />;
    case 'file':
    case 'image':
    case 'readme':
      return <TerminalIcon size={12} style={{ color: '#60a5fa' }} />;
    default:
      return <GitCommit size={12} style={{ color: '#94a3b8' }} />;
  }
}

const TabBar = memo(function TabBar({
  tabs,
  activeTabId,
  launchRequestKey,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onNewChatTab,
  onNewLLMChatTab,
  scopedRepo,
  onRegisterRepo,
  onSplitVertical,
  onSplitHorizontal,
  canCloseTile,
  onCloseTile,
}: {
  tabs: TerminalTab[];
  activeTabId: string;
  launchRequestKey?: number;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: (agentId: string, repo?: RegisteredRepo) => void;
  onNewChatTab: (runtime: 'codex' | 'claude-code', repo?: RegisteredRepo) => void;
  onNewLLMChatTab: (repo?: RegisteredRepo) => void;
  scopedRepo?: RegisteredRepo | null;
  onRegisterRepo?: (localPath: string) => void;
  onSplitVertical?: () => void;
  onSplitHorizontal?: () => void;
  canCloseTile?: boolean;
  onCloseTile?: () => void;
}) {
  const [tauriMode, setTauriMode] = useState(false);
  useEffect(() => { setTauriMode(isTauri()); }, []);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerStep, setPickerStep] = useState<'main' | 'terminal' | 'session' | 'repo'>('main');
  const [selectedAgent, setSelectedAgent] = useState<typeof CLI_AGENTS[0] | null>(null);
  const [repos, setRepos] = useState<RegisteredRepo[]>([]);
  const pickerRef = useRef<HTMLDivElement>(null);
  const tabScrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const syncTabScroll = useCallback(() => {
    const el = tabScrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);
  const scrollTabs = useCallback((dir: 'left' | 'right') => {
    tabScrollRef.current?.scrollBy({ left: dir === 'left' ? -180 : 180, behavior: 'smooth' });
  }, []);
  // Check overflow after tabs change (deferred to avoid layout thrash)
  useEffect(() => {
    const raf = requestAnimationFrame(syncTabScroll);
    return () => cancelAnimationFrame(raf);
  }, [tabs.length, syncTabScroll]);

  const openLaunchPicker = () => {
    setSelectedAgent(null);
    setPickerStep('main');
    setPickerOpen(true);
  };

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
        setPickerStep('main');
        setSelectedAgent(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen]);

  useEffect(() => {
    if (!launchRequestKey) return;
    openLaunchPicker();
  }, [launchRequestKey]);

  // Fetch repos when picker opens
  useEffect(() => {
    if (!pickerOpen) return;
    fetch('/api/panel/repos')
      .then(r => r.json())
      .then(data => setRepos(data.repos ?? []))
      .catch(() => setRepos([]));
  }, [pickerOpen]);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'stretch',
      height: 32,
      background: 'transparent',
      borderBottom: '0.5px solid var(--t-divider-subtle)',
      flexShrink: 0,
      overflow: 'visible',
      zIndex: 10,
      position: 'relative',
    }}>
      {/* Tabs — scrollable with transparent arrow overlays */}
      <div style={{ position: 'relative', display: 'flex', flex: 1, overflow: 'hidden' }}>
        {canScrollLeft && (
          <div onClick={() => scrollTabs('left')} style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: 28, display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 3, cursor: 'pointer',
            background: 'linear-gradient(to right, rgba(0, 0, 0, 0.15) 60%, transparent)',
            color: 'var(--t-text-secondary)',
          }}>
            <PhosphorCaretLeft size={12} />
          </div>
        )}
        {canScrollRight && (
          <div onClick={() => scrollTabs('right')} style={{
            position: 'absolute', right: 0, top: 0, bottom: 0, width: 28, display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 3, cursor: 'pointer',
            background: 'linear-gradient(to left, rgba(0, 0, 0, 0.15) 60%, transparent)',
            color: 'var(--t-text-secondary)',
          }}>
            <PhosphorCaretRight size={12} />
          </div>
        )}
        <div ref={tabScrollRef} onScroll={syncTabScroll} onMouseEnter={syncTabScroll} style={{
          display: 'flex', flex: 1, gap: 0, overflowX: 'auto', overflowY: 'hidden',
          scrollbarWidth: 'none',
        }}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const agent = CLI_AGENTS.find(a => a.id === tab.cliAgent);
          const taskMeta = parseWorkspaceTaskLabel(tab.label);
          const taskState = taskMeta ? inferWorkspaceTaskState(tab) : null;
          const chatTabMeta = describeWorkspaceChatTab(tab);
          const runtimeTone = tab.kind === 'chat'
            ? orchestratorRuntimeTone(tab.orchestrationPacket?.runtime ?? tab.chatRuntime)
            : tab.orchestrationPacket
              ? orchestratorRuntimeTone(tab.orchestrationPacket.runtime)
              : manualLaneRuntimeTone(tab);
          const orchestrationTone = tab.orchestrationPacket
            ? orchestratorStatusTone(tab.orchestrationPacket.status)
            : (tab.kind === 'chat' || tab.kind === 'terminal'
              ? activeManualLaneStatus(tab)
              : null);
          const checkpointCount = tab.kind === 'chat' ? (tab.chatCheckpoints?.length ?? 0) : 0;
          const primaryLabel = workspaceTabPrimaryLabel(tab);
          const tabDetail = tab.orchestrationPacket
            ? (chatTabMeta?.detail ?? tab.orchestrationPacket.branchTarget ?? null)
            : (chatTabMeta?.summary ?? chatTabMeta?.detail ?? null);
          const showSecondaryRow = Boolean(
            tabDetail
            || runtimeTone
            || (tab.kind !== 'chat' && tab.kind !== 'llm-chat' && (taskMeta || checkpointCount > 0))
          );
          const tabTitle = [
            primaryLabel,
            tabDetail,
            chatTabMeta?.fullSummary,
          ].filter((value): value is string => Boolean(value)).join(' — ');
          return (
            <button
              type="button"
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              title={tabTitle || tab.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                paddingTop: 0,
                paddingRight: 12,
                paddingBottom: 0,
                paddingLeft: 12,
                height: '100%',
                border: 'none',
                borderBottom: isActive ? 'none' : '0.5px solid transparent',
                background: isActive ? '#fff' : 'transparent',
                color: isActive ? '#111827' : 'rgba(255, 255, 255, 0.85)',
                fontSize: 12,
                fontWeight: isActive ? 600 : 400,
                fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
                letterSpacing: '-0.008em',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'color 120ms ease, background 120ms ease',
                borderRadius: 0,
                marginBottom: isActive ? -0.5 : 0,
                borderRight: '0.5px solid var(--t-divider-subtle)',
              }}
            >
              {/* Icons removed — text-only minimal tabs */}
                <span style={{
                  maxWidth: 160,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                }}>
                  {primaryLabel}
                </span>
              {tabs.length > 1 && (
                <span
                  onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onCloseTab(tab.id); } }}
                  role="button"
                  tabIndex={0}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    marginLeft: 4,
                    color: 'var(--t-text-secondary)',
                    cursor: 'pointer',
                    transition: 'background 100ms, color 100ms',
                  }}
                  onMouseEnter={(e) => {
                    (e.target as HTMLElement).style.background = 'rgba(239, 68, 68, 0.15)';
                    (e.target as HTMLElement).style.color = '#ef4444';
                  }}
                  onMouseLeave={(e) => {
                    (e.target as HTMLElement).style.background = 'transparent';
                    (e.target as HTMLElement).style.color = '#475569';
                  }}
                >
                  <PhosphorXBold size={10} />
                </span>
              )}
            </button>
          );
        })}
        </div>
      </div>

      {/* Launch button */}
      <div ref={pickerRef} style={{ position: 'relative', flexShrink: 0 }}>
        <button
          type="button"
          onClick={() => {
            if (pickerOpen) {
              setPickerOpen(false);
              setPickerStep('main');
              setSelectedAgent(null);
              return;
            }
            openLaunchPicker();
          }}
          aria-label="Launch agent"
          title="Launch agent"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            marginTop: 4,
            marginRight: 8,
            borderRadius: 7,
            border: 'none',
            background: pickerOpen ? THEME_ACCENT_SOFT : 'transparent',
            color: THEME_ACCENT,
            cursor: 'pointer',
            flexShrink: 0,
            boxShadow: 'none',
            transition: 'background 100ms, color 100ms',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = THEME_ACCENT_SOFT;
          }}
          onMouseLeave={(e) => {
            if (!pickerOpen) {
              e.currentTarget.style.background = 'transparent';
            }
          }}
        >
          <PhosphorPlay size={13} />
        </button>

        {/* Picker dropdown */}
        {pickerOpen && (
          <div style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            zIndex: 9000,
            marginTop: 4,
            minWidth: 220,
            background: THEME_PANEL_GLASS,
            border: '1px solid var(--t-panel-border)',
            borderRadius: 10,
            overflow: 'hidden',
            boxShadow: 'var(--t-panel-shadow)',
          }}>
            {/* Step 1: Main menu — 3 clear choices */}
            {pickerStep === 'main' && (<>
              {/* New Chat — direct LLM, opens immediately */}
              <button
                type="button"
                onClick={() => {
                  onNewLLMChatTab(scopedRepo ?? undefined);
                  setPickerOpen(false);
                  setPickerStep('main');
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  paddingTop: 10,
                  paddingRight: 12,
                  paddingBottom: 10,
                  paddingLeft: 12,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--t-text)',
                  fontSize: 13,
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background 100ms',
                }}
                onMouseEnter={(e) => { (e.currentTarget).style.background = THEME_ACCENT_SOFT; }}
                onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; }}
              >
                <span style={{ width: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <MessageSquare size={14} style={{ color: THEME_ACCENT }} />
                </span>
                <div>
                  <div style={{ fontWeight: 500 }}>New Chat</div>
                  <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Direct LLM conversation</div>
                </div>
              </button>

              <div style={{ height: 1, background: 'var(--t-divider)' }} />

              {/* CLI Terminal — cascading submenu */}
              <button
                type="button"
                onClick={() => setPickerStep('terminal')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  paddingTop: 10,
                  paddingRight: 12,
                  paddingBottom: 10,
                  paddingLeft: 12,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--t-text)',
                  fontSize: 13,
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background 100ms',
                }}
                onMouseEnter={(e) => { (e.currentTarget).style.background = THEME_ACCENT_SOFT; }}
                onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; }}
              >
                <span style={{ width: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <TerminalIcon size={14} style={{ color: 'var(--t-text-secondary)' }} />
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>CLI Terminal</div>
                  <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Shell or agent CLI</div>
                </div>
                <ChevronRight size={12} style={{ color: 'var(--t-text-muted)' }} />
              </button>

              {/* CLI Session — cascading submenu */}
              <button
                type="button"
                onClick={() => setPickerStep('session')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  paddingTop: 10,
                  paddingRight: 12,
                  paddingBottom: 10,
                  paddingLeft: 12,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--t-text)',
                  fontSize: 13,
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background 100ms',
                }}
                onMouseEnter={(e) => { (e.currentTarget).style.background = THEME_ACCENT_SOFT; }}
                onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; }}
              >
                <span style={{ width: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Radio size={14} style={{ color: '#8b5cf6' }} />
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>CLI Session</div>
                  <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Agent conversation</div>
                </div>
                <ChevronRight size={12} style={{ color: 'var(--t-text-muted)' }} />
              </button>
            </>)}

            {/* Step 2a: CLI Terminal submenu */}
            {pickerStep === 'terminal' && (<>
              <button
                type="button"
                onClick={() => setPickerStep('main')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  width: '100%',
                  paddingTop: 6,
                  paddingRight: 10,
                  paddingBottom: 6,
                  paddingLeft: 10,
                  border: 'none',
                  borderBottom: '1px solid #f1f5f9',
                  background: 'transparent',
                  color: '#94a3b8',
                  fontSize: 11,
                  cursor: 'pointer',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                }}
              >
                ← CLI Terminal
              </button>
              {CLI_AGENTS.map((agent) => (
                <button
                  type="button"
                  key={agent.id}
                  onClick={() => {
                    if (scopedRepo) {
                      onNewTab(agent.id, scopedRepo);
                      setPickerOpen(false);
                      setPickerStep('main');
                      return;
                    }
                    if (agent.id === 'shell') {
                      onNewTab(agent.id);
                      setPickerOpen(false);
                      setPickerStep('main');
                    } else {
                      setSelectedAgent(agent);
                      setPickerStep('repo');
                    }
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    paddingTop: 8,
                    paddingRight: 12,
                    paddingBottom: 8,
                    paddingLeft: 12,
                    border: 'none',
                    background: 'transparent',
                    color: '#1e293b',
                    fontSize: 13,
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 100ms',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget).style.background = '#f1f5f9'; }}
                  onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; }}
                >
                  <span style={{ width: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {agent.id === 'shell' ? (
                      <TerminalIcon size={14} style={{ color: '#94a3b8' }} />
                    ) : (
                      <AgentDot color={agent.color} size={10} />
                    )}
                  </span>
                  <div>
                    <div style={{ fontWeight: 500 }}>{agent.label}</div>
                    {agent.command && (
                      <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'ui-monospace, monospace' }}>
                        $ {agent.command}
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </>)}

            {/* Step 2b: CLI Session submenu */}
            {pickerStep === 'session' && (<>
              <button
                type="button"
                onClick={() => setPickerStep('main')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  width: '100%',
                  paddingTop: 6,
                  paddingRight: 10,
                  paddingBottom: 6,
                  paddingLeft: 10,
                  border: 'none',
                  borderBottom: '1px solid #f1f5f9',
                  background: 'transparent',
                  color: '#94a3b8',
                  fontSize: 11,
                  cursor: 'pointer',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                }}
              >
                ← CLI Session
              </button>
              {([
                { id: 'codex' as const, label: 'Codex', color: '#10b981' },
                { id: 'claude-code' as const, label: 'Claude Code', color: '#8b5cf6' },
              ]).map((rt) => (
                <button
                  type="button"
                  key={`session-${rt.id}`}
                  onClick={() => {
                    onNewChatTab(rt.id, scopedRepo ?? undefined);
                    setPickerOpen(false);
                    setPickerStep('main');
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    paddingTop: 8,
                    paddingRight: 12,
                    paddingBottom: 8,
                    paddingLeft: 12,
                    border: 'none',
                    background: 'transparent',
                    color: '#1e293b',
                    fontSize: 13,
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 100ms',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget).style.background = '#f1f5f9'; }}
                  onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; }}
                >
                  <span style={{ width: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <AgentDot color={rt.color} size={10} />
                  </span>
                  <div>
                    <div style={{ fontWeight: 500 }}>{rt.label}</div>
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>Agent conversation</div>
                  </div>
                </button>
              ))}
            </>)}

            {/* Step 2: Pick a repo (or launch without repo) */}
            {pickerStep === 'repo' && selectedAgent && (<>
              <button
                type="button"
                onClick={() => { setPickerStep('terminal'); setSelectedAgent(null); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  width: '100%',
                  paddingTop: 6,
                  paddingRight: 10,
                  paddingBottom: 6,
                  paddingLeft: 10,
                  border: 'none',
                  borderBottom: '1px solid #f1f5f9',
                  background: 'transparent',
                  color: '#94a3b8',
                  fontSize: 11,
                  cursor: 'pointer',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                }}
              >
                ← {selectedAgent.label}
              </button>
              <div style={{
                paddingTop: 6,
                paddingRight: 10,
                paddingBottom: 4,
                paddingLeft: 10,
                fontSize: 10,
                fontWeight: 600,
                color: '#94a3b8',
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
              }}>
                Select Repo
              </div>

              {/* No repo — launch in home dir */}
              <button
                type="button"
                onClick={() => {
                  onNewTab(selectedAgent.id);
                  setPickerOpen(false);
                  setPickerStep('terminal');
                  setSelectedAgent(null);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  paddingTop: 8,
                  paddingRight: 12,
                  paddingBottom: 8,
                  paddingLeft: 12,
                  border: 'none',
                  background: 'transparent',
                  color: '#64748b',
                  fontSize: 13,
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  transition: 'background 100ms',
                }}
                onMouseEnter={(e) => { (e.currentTarget).style.background = '#f1f5f9'; }}
                onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; }}
              >
                <TerminalIcon size={14} style={{ color: '#94a3b8' }} />
                <div>
                  <div style={{ fontWeight: 500 }}>No repo (home dir)</div>
                  <div style={{ fontSize: 11, color: '#94a3b8' }}>~/</div>
                </div>
              </button>

              {/* Registered repos */}
              {repos.length > 0 && (
                <div style={{
                  paddingTop: 6,
                  paddingRight: 10,
                  paddingBottom: 4,
                  paddingLeft: 10,
                  fontSize: 10,
                  fontWeight: 600,
                  color: '#94a3b8',
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                }}>
                  Repos
                </div>
              )}
              {repos.map((repo) => (
                <button
                  type="button"
                  key={repo.localPath}
                  onClick={() => {
                    onNewTab(selectedAgent.id, repo);
                    setPickerOpen(false);
                    setPickerStep('terminal');
                    setSelectedAgent(null);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    paddingTop: 8,
                    paddingRight: 12,
                    paddingBottom: 8,
                    paddingLeft: 12,
                    border: 'none',
                    background: 'transparent',
                    color: '#1e293b',
                    fontSize: 13,
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    transition: 'background 100ms',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget).style.background = '#f1f5f9'; }}
                  onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; }}
                >
                  <AgentDot color={selectedAgent.color} size={8} />
                  <div>
                    <div style={{ fontWeight: 500 }}>{repo.name}</div>
                    <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'ui-monospace, monospace' }}>
                      {repo.localPath.replace(/^\/Users\/[^/]+\//, '~/')}
                    </div>
                  </div>
                </button>
              ))}

              {/* Divider */}
              <div style={{ height: 1, background: '#f1f5f9', marginTop: 4, marginBottom: 4 }} />

              {/* Open folder — native dialog */}
              <button
                type="button"
                onClick={async () => {
                  let folderPath: string | null = null;

                  // Try Tauri native dialog first (gives real filesystem path)
                  try {
                    const { open } = await import('@tauri-apps/plugin-dialog');
                    const result = await open({ directory: true, title: 'Select project folder' });
                    if (typeof result === 'string') folderPath = result;
                  } catch {
                    // Not in Tauri (browser dev mode) — use server-side folder picker
                    try {
                      const res = await fetch('/api/panel/browse-folder', { method: 'POST' });
                      const data = await res.json();
                      if (data.path) folderPath = data.path;
                    } catch {
                      // Last resort
                      folderPath = window.prompt('Enter folder path:');
                    }
                  }

                  if (folderPath && selectedAgent) {
                    const folderName = folderPath.split('/').filter(Boolean).pop() ?? 'folder';
                    onNewTab(selectedAgent.id, { name: folderName, localPath: folderPath });
                    // Auto-register so it shows under Repos next time
                    onRegisterRepo?.(folderPath);
                    setPickerOpen(false);
                    setPickerStep('terminal');
                    setSelectedAgent(null);
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  paddingTop: 8,
                  paddingRight: 12,
                  paddingBottom: 8,
                  paddingLeft: 12,
                  border: 'none',
                  background: 'transparent',
                  color: '#1e293b',
                  fontSize: 13,
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  transition: 'background 100ms',
                }}
                onMouseEnter={(e) => { (e.currentTarget).style.background = '#f1f5f9'; }}
                onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; }}
              >
                <span style={{ fontSize: 14, color: '#94a3b8', width: 20, textAlign: 'center' }}>📂</span>
                <div style={{ fontWeight: 500 }}>Open folder...</div>
              </button>
            </>)}
          </div>
        )}
      </div>

      {/* Compact split / close controls */}
      {(onSplitVertical || onSplitHorizontal || (canCloseTile && onCloseTile)) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 1, paddingRight: 6, flexShrink: 0, borderLeft: '0.5px solid var(--t-divider-subtle)', marginLeft: 2, paddingLeft: 4 }}>
          {onSplitVertical && (
            <button
              type="button"
              onClick={onSplitVertical}
              aria-label="Split vertically"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 22, height: 22, borderRadius: 6, border: 'none',
                background: 'transparent', color: 'var(--t-text-faint)', cursor: 'pointer',
                transition: 'background 100ms, color 100ms',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; e.currentTarget.style.color = 'var(--t-text-secondary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--t-text-faint)'; }}
            >
              <PhosphorSplitVertical size={14} />
            </button>
          )}
          {onSplitHorizontal && (
            <button
              type="button"
              onClick={onSplitHorizontal}
              aria-label="Split horizontally"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 22, height: 22, borderRadius: 6, border: 'none',
                background: 'transparent', color: 'var(--t-text-faint)', cursor: 'pointer',
                transition: 'background 100ms, color 100ms',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; e.currentTarget.style.color = 'var(--t-text-secondary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--t-text-faint)'; }}
            >
              <PhosphorSplitHorizontal size={14} />
            </button>
          )}
          {canCloseTile && onCloseTile && (
            <button
              type="button"
              onClick={onCloseTile}
              aria-label="Close tile"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 22, height: 22, borderRadius: 6, border: 'none',
                background: 'transparent', color: 'var(--t-text-faint)', cursor: 'pointer',
                transition: 'background 100ms, color 100ms',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)'; e.currentTarget.style.color = '#ef4444'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--t-text-faint)'; }}
            >
              <PhosphorXCircle size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
});

/* ── Main Component ── */

export const WorkspaceTerminal = forwardRef<TerminalTabHandle, WorkspaceTerminalProps>(
  function WorkspaceTerminal(
    {
      stateScope,
      defaultTab,
      autoCreateDefaultTab = true,
      preferredRepo = null,
      splitCreated = false,
      availableRepos = [],
      openRepoPaths = [],
      onActiveChatSessionChange,
      onChatSessionsChange,
      onActiveLaneChange,
      onRepoScopeChange,
      onActiveRepoContextChange,
      onSelectRepoScope,
      onOpenRepoDiff,
      onInjectChatContext,
      onSelectCommit,
      onLaunchWorkspaceTask,
      onSplitVertical,
      onSplitHorizontal,
      canCloseTile = false,
      onCloseTile,
      sendTerminalCreate,
      sendTerminalAttach,
      sendTerminalInput,
      sendTerminalResize,
      sendTerminalDetach,
      termWsConnected,
      onPreviewDetected,
      onPreviewSelection,
      showPreviewPane = true,
    },
    ref,
  ) {
    const [inTauri, setInTauri] = useState(false);
    useEffect(() => { setInTauri(isTauri()); }, []);
    const [tabs, setTabs] = useState<TerminalTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string>('');
    const [previews, setPreviews] = useState<LocalhostPreview[]>([]);
    const [repoPickerOpen, setRepoPickerOpen] = useState(false);
    const [restoreCompletedKey, setRestoreCompletedKey] = useState<string | null>(null);
    const tabsRef = useRef<TerminalTab[]>([]);
    const panelRefs = useRef<Map<string, XtermPanelHandle>>(new Map());
    const repoPickerRef = useRef<HTMLDivElement>(null);
    const pendingCliCommands = useRef<Map<string, string>>(new Map()); // tabId → command to run after session created
    const pendingRequestRef = useRef<Map<string, string>>(new Map()); // requestId → tabId
    const restoredRef = useRef(false);
    const restoreSettledRef = useRef(false);
    const restoreInFlightRef = useRef(false);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const detectedPortsRef = useRef<Set<number>>(new Set()); // avoid duplicate detections
    const urlDetectionEnabledRef = useRef(false); // suppress during initial replay
    const previousWsConnectedRef = useRef(false);
    const termWsConnectedRef = useRef(termWsConnected);
    const initialTerminalBootstrapRef = useRef(false);
    const restoreKeyRef = useRef<string | null>(null);
    const preferredRepoRef = useRef(preferredRepo);
    preferredRepoRef.current = preferredRepo;
    const reportedRepoScopeRef = useRef<string | null | undefined>(undefined);
    const chatSessionsChangeRef = useRef(onChatSessionsChange);
    const activeChatSessionChangeRef = useRef(onActiveChatSessionChange);
    const reportedChatSessionsSignatureRef = useRef<string>('');
    const reportedActiveChatSessionKeyRef = useRef<string | null>(null);
    const stableRepoScope = !splitCreated && preferredRepo?.localPath
      ? buildRepoStateScope(preferredRepo.localPath)
      : null;
    const resolvePersistenceScope = useCallback((currentTabs: TerminalTab[]) => {
      const preferredRepoPath = preferredRepoRef.current?.localPath ?? null;
      if (
        stableRepoScope
        && preferredRepoPath
        && currentTabs.every((tab) => !tab.repo?.localPath || tab.repo.localPath === preferredRepoPath)
      ) {
        return stableRepoScope;
      }
      return stateScope;
    }, [stableRepoScope, stateScope]);
    const restoreKey = useMemo(
      () => [
        stateScope,
        defaultTab,
        splitCreated ? 'split' : 'shared',
        preferredRepo?.localPath ?? 'no-repo',
      ].join('::'),
      [defaultTab, preferredRepo?.localPath, splitCreated, stateScope],
    );
    const primaryRestoreSettled = restoreCompletedKey === restoreKey;
    const visibleTabs = useMemo(
      () => tabs.filter((tab) => !(tab.kind === 'canvas' && tab.canvasTab?.kind === 'ci')),
      [tabs],
    );
    const effectiveActiveTabId = useMemo(
      () => visibleTabs.some((tab) => tab.id === activeTabId)
        ? activeTabId
        : (visibleTabs[visibleTabs.length - 1]?.id ?? ''),
      [activeTabId, visibleTabs],
    );

    useEffect(() => {
      chatSessionsChangeRef.current = onChatSessionsChange;
      activeChatSessionChangeRef.current = onActiveChatSessionChange;
    }, [onActiveChatSessionChange, onChatSessionsChange]);

    useEffect(() => {
      termWsConnectedRef.current = termWsConnected;
    }, [termWsConnected]);

    useEffect(() => {
      if (!repoPickerOpen) return;
      const handlePointerDown = (event: MouseEvent) => {
        if (repoPickerRef.current && !repoPickerRef.current.contains(event.target as Node)) {
          setRepoPickerOpen(false);
        }
      };
      document.addEventListener('mousedown', handlePointerDown);
      return () => document.removeEventListener('mousedown', handlePointerDown);
    }, [repoPickerOpen]);

    useEffect(() => {
      const previousKey = restoreKeyRef.current;
      if (previousKey === restoreKey) return;
      restoreKeyRef.current = restoreKey;
      const nextPreferredRepoPath = preferredRepo?.localPath ?? null;
      const currentTabs = tabsRef.current;
      const hasOrchestratedTabs = currentTabs.some((tab) => Boolean(tab.orchestrationPacket));
      const canPreserveScopedTabs = previousKey !== null
        && currentTabs.length > 0
        && (
          hasOrchestratedTabs
          || (
            nextPreferredRepoPath
            && currentTabs.some((tab) => tab.repo?.localPath === nextPreferredRepoPath)
            && currentTabs.every((tab) => !tab.repo?.localPath || tab.repo.localPath === nextPreferredRepoPath)
          )
        );

      if (previousKey === null) {
        // First run — just record the key without resetting state
        return;
      }

      // If a restore is still in flight (loadTabState / applyPersistedState pending),
      // the tile scope is the same, and the only change is preferredRepo resolving,
      // let the in-flight restore finish instead of cancelling and restarting.
      // This prevents a race where loadRegisteredRepos resolves before the first
      // loadTabState completes, causing tabs to be cleared mid-restore.
      const previousScope = previousKey.split('::')[0];
      const nextScope = restoreKey.split('::')[0];
      if (
        restoreInFlightRef.current
        && previousScope === nextScope
        && currentTabs.length === 0
      ) {
        return;
      }

      restoredRef.current = false;
      restoreSettledRef.current = false;
      previousWsConnectedRef.current = false;
      initialTerminalBootstrapRef.current = false;
      reportedRepoScopeRef.current = undefined;
      reportedChatSessionsSignatureRef.current = '';
      reportedActiveChatSessionKeyRef.current = null;
      detectedPortsRef.current.clear();
      pendingCliCommands.current.clear();
      pendingRequestRef.current.clear();
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (canPreserveScopedTabs) {
        restoredRef.current = true;
        restoreSettledRef.current = true;
        const preserveFrame = window.requestAnimationFrame(() => {
          setRestoreCompletedKey(restoreKey);
        });
        return () => window.cancelAnimationFrame(preserveFrame);
      }
      urlDetectionEnabledRef.current = false;
      const resetFrame = window.requestAnimationFrame(() => {
        setPreviews([]);
        tabsRef.current = [];
        setTabs([]);
        setActiveTabId('');
      });
      return () => window.cancelAnimationFrame(resetFrame);
    }, [preferredRepo?.localPath, restoreKey]);

    useEffect(() => {
      const preferredLocalPath = preferredRepo?.localPath ?? '';
      const preferredBranch = preferredRepo?.branch ?? 'main';
      const nextSessions: MobileInboxSnapshot['sessions'] = visibleTabs
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
            currentTask: tab.orchestrationPacket?.title
              ?? latestMessage?.text?.trim()
              ?? (hasLiveSession
                ? ''
                : 'Idle'),
            workspace: tab.repo?.localPath ?? preferredLocalPath,
            branch: tab.repo?.branch ?? preferredBranch,
            sessionKey: prefixedKey,
            approvalStatus: 'none',
            lastEventAt: new Date(tab.lastActivity).toISOString(),
            context: { usedPercent: 0, trend: 'stable' as const },
            alerts: 0,
            surfaceLabel: laneTitle,
            isCurrentSession: tab.id === effectiveActiveTabId,
            orchestrationPacket: tab.orchestrationPacket ?? null,
            runtimeSurface: {
              id: prefixedKey,
              runtime,
              kind: 'chat-session',
              ownership: 'owned',
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
      const nextSessionsSignature = JSON.stringify(nextSessions.map((session) => ({
        sessionKey: session.sessionKey,
        status: session.status,
        name: session.name,
        currentTask: session.currentTask,
        workspace: session.workspace,
        branch: session.branch,
        lastEventAt: session.lastEventAt,
      })));
      if (reportedChatSessionsSignatureRef.current !== nextSessionsSignature) {
        reportedChatSessionsSignatureRef.current = nextSessionsSignature;
        chatSessionsChangeRef.current?.(nextSessions);
      }
      const activeChat = nextSessions.find((session) => session.isCurrentSession)
        ?? nextSessions.find((session) => session.sessionKey === reportedActiveChatSessionKeyRef.current)
        ?? nextSessions[0]
        ?? null;
      const nextActiveSessionKey = activeChat?.sessionKey ?? null;
      if (reportedActiveChatSessionKeyRef.current !== nextActiveSessionKey) {
        reportedActiveChatSessionKeyRef.current = nextActiveSessionKey;
        activeChatSessionChangeRef.current?.(nextActiveSessionKey);
      }
    }, [effectiveActiveTabId, preferredRepo?.branch, preferredRepo?.localPath, stableRepoScope, stateScope, visibleTabs]);

    const serializePersistedTabs = useCallback((currentTabs: TerminalTab[]) => (
      currentTabs
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
        }))
    ), []);

    const persistTabsNow = useCallback((currentTabs: TerminalTab[], currentActiveId: string) => {
      const persistableTabs = serializePersistedTabs(currentTabs);
      const nextActiveId = persistableTabs.length === 0
        ? ''
        : persistableTabs.some((tab) => tab.id === currentActiveId)
          ? currentActiveId
          : (persistableTabs[persistableTabs.length - 1]?.id ?? '');
      const persisted: PersistedTabState = {
        version: 1,
        activeTabId: nextActiveId,
        tabs: persistableTabs,
        savedAt: new Date().toISOString(),
      };
      const persistenceScope = resolvePersistenceScope(currentTabs);
      void saveTabState(persisted, persistenceScope);

      if (persistenceScope !== stateScope) {
        if (stateScope === 'tile-root') {
          void saveTabState(persisted, stateScope);
        } else {
          void saveTabState({
            version: 1,
            activeTabId: '',
            tabs: [],
            savedAt: persisted.savedAt,
          }, stateScope);
        }
      }
    }, [resolvePersistenceScope, serializePersistedTabs, stateScope]);

    // Persist tab state (debounced — saves 500ms after last change)
    const persistTabs = useCallback((currentTabs: TerminalTab[], currentActiveId: string) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        persistTabsNow(currentTabs, currentActiveId);
      }, 500);
    }, [persistTabsNow]);

    const requestTerminalForTab = useCallback((tabId: string, command?: string) => {
      const requestId = `workspace-${tabId}-${Date.now()}`;
      pendingRequestRef.current.set(requestId, tabId);
      if (command) {
        pendingCliCommands.current.set(tabId, command);
      }
      sendTerminalCreate(120, 30, requestId);
    }, [sendTerminalCreate]);

    // Save whenever tabs or active tab changes
    useEffect(() => {
      tabsRef.current = tabs;
      if (restoreSettledRef.current) {
        persistTabs(tabs, effectiveActiveTabId);
      }
    }, [effectiveActiveTabId, persistTabs, restoreCompletedKey, tabs]);

    const createDefaultShellTab = useCallback((): TerminalTab => {
      const now = Date.now();
      return {
        id: createWorkspaceTabId('terminal'),
        label: 'Shell',
        kind: 'terminal',
        tmuxSession: null,
        cliAgent: 'shell',
        createdAt: now,
        lastActivity: now,
      };
    }, []);

    const createDefaultChatTab = useCallback((): TerminalTab => {
      const now = Date.now();
      return {
        id: generateLlmChatTabId(),
        label: 'Chat',
        kind: 'llm-chat',
        tmuxSession: null,
        repo: preferredRepoRef.current ?? undefined,
        linkedIssue: null,
        createdAt: now,
        lastActivity: now,
      };
    }, []);

    const applyPersistedState = useCallback(async (saved: PersistedTabState, cancelled?: () => boolean) => {
      const tmuxNames = saved.tabs.map((t) => t.tmuxSession).filter(Boolean) as string[];

      // If every saved tab is orchestrated or a non-runtime tab, skip the
      // potentially slow liveness API calls entirely — these tabs should
      // always be restored from their persisted state.
      const needsLivenessCheck = saved.tabs.some((t) => {
        const kind = t.kind ?? 'terminal';
        if (kind === 'terminal') return true;
        if (kind === 'chat' && !t.orchestrationPacket) return true;
        return false;
      });

      let alive: Set<string>;
      let liveRuntimeSessionKeys: Set<import('@/lib/terminal/tab-state').PersistedRuntimeSessionKey>;

      if (needsLivenessCheck) {
        // Race liveness checks against a timeout so slow API calls don't block
        // tab restoration. Tabs are restored with optimistic session keys and
        // validated asynchronously.
        try {
          const result = await Promise.race([
            Promise.all([checkAliveSessions(tmuxNames), loadLiveRuntimeSessionKeys()]),
            new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
          ]);
          if (result === 'timeout') {
            alive = new Set(tmuxNames);
            liveRuntimeSessionKeys = new Set();
          } else {
            [alive, liveRuntimeSessionKeys] = result;
          }
        } catch {
          alive = new Set(tmuxNames);
          liveRuntimeSessionKeys = new Set();
        }
      } else {
        // Optimistically treat all saved sessions as alive so orchestrated
        // tabs keep their session keys on restore.
        alive = new Set(tmuxNames);
        const optimisticKeys = saved.tabs
          .map((t) => formatPersistedRuntimeSessionKey(t.chatRuntime, t.chatSessionKey))
          .filter((k): k is import('@/lib/terminal/tab-state').PersistedRuntimeSessionKey => k !== null);
        liveRuntimeSessionKeys = new Set(optimisticKeys);
      }
      if (cancelled?.()) return false;

      // Read preferred repo from ref to avoid stale closure — the prop may
      // change while this async function is in flight but the ref always
      // reflects the latest value.
      const currentPreferredRepo = preferredRepoRef.current;

      const restoredTabs: TerminalTab[] = [];
      const sessionsToAttach: string[] = [];
      const seenRuntimeChats = new Set<string>();
      const seenTerminalSessions = new Set<string>();
      const seenTabIds = new Set<string>();
      let restoredActiveTabId: string | null = null;

      for (const st of saved.tabs) {
        if (cancelled?.()) return false;
        const now = Date.now();
        const tabKind = st.kind ?? 'terminal';

        if (tabKind === 'llm-chat') {
          const tabId = claimWorkspaceTabId('llm-chat', seenTabIds, st.id);
          restoredTabs.push({
            id: tabId,
            label: st.label,
            kind: 'llm-chat',
            tmuxSession: null,
            repo: st.repoPath ? { name: st.repoName ?? 'repo', localPath: st.repoPath } : (currentPreferredRepo ?? undefined),
            linkedIssue: st.linkedIssue ?? null,
            createdAt: now,
            lastActivity: now,
          });
          if (st.id === saved.activeTabId) restoredActiveTabId = tabId;
          continue;
        }

        if (tabKind === 'chat') {
          const prefixedSessionKey = formatPersistedRuntimeSessionKey(st.chatRuntime, st.chatSessionKey);
          if (prefixedSessionKey && seenRuntimeChats.has(`${prefixedSessionKey}:${st.repoPath ?? ''}`)) {
            continue;
          }
          if (prefixedSessionKey) {
            seenRuntimeChats.add(`${prefixedSessionKey}:${st.repoPath ?? ''}`);
          }
          const liveSessionKey = prefixedSessionKey && liveRuntimeSessionKeys.has(prefixedSessionKey)
            ? stripPersistedRuntimeSessionKey(st.chatRuntime, st.chatSessionKey)
            : undefined;
          const tabId = claimWorkspaceTabId('chat', seenTabIds, st.id);
          restoredTabs.push({
            id: tabId,
            label: st.label,
            kind: 'chat',
            tmuxSession: null,
            chatRuntime: st.chatRuntime,
            chatSessionKey: liveSessionKey,
            chatModel: st.chatModel,
            chatContinueLatest: liveSessionKey ? st.chatContinueLatest : false,
            chatCheckpoints: st.chatCheckpoints ?? [],
            repo: st.repoPath ? { name: st.repoName ?? 'repo', localPath: st.repoPath } : (currentPreferredRepo ?? undefined),
            linkedIssue: st.linkedIssue ?? null,
            orchestrationPacket: st.orchestrationPacket ?? null,
            supervisorStatus: st.supervisorStatus ?? null,
            autoArchiveOnIdle: st.autoArchiveOnIdle ?? false,
            createdAt: now,
            lastActivity: now,
            chatMessages: [],
          });
          if (st.id === saved.activeTabId) restoredActiveTabId = tabId;
          continue;
        }

        if (tabKind === 'canvas' && st.canvasTab) {
          if (st.canvasTab.kind === 'ci') continue;
          const tabId = claimWorkspaceTabId('canvas', seenTabIds, st.id);
          restoredTabs.push({
            id: tabId,
            label: st.label,
            kind: 'canvas',
            tmuxSession: null,
            repo: st.repoPath ? { name: st.repoName ?? 'repo', localPath: st.repoPath } : (currentPreferredRepo ?? undefined),
            canvasTab: {
              id: st.canvasTab.id,
              kind: st.canvasTab.kind as CanvasTab['kind'],
              label: st.canvasTab.label,
              resourceId: st.canvasTab.resourceId,
              meta: st.canvasTab.meta,
            },
            createdAt: now,
            lastActivity: now,
          });
          if (st.id === saved.activeTabId) restoredActiveTabId = tabId;
          continue;
        }

        const tabId = claimWorkspaceTabId('terminal', seenTabIds, st.id);
        if (st.tmuxSession && alive.has(st.tmuxSession) && !seenTerminalSessions.has(st.tmuxSession)) {
          seenTerminalSessions.add(st.tmuxSession);
          restoredTabs.push({
            id: tabId,
            label: st.label,
            kind: 'terminal',
            tmuxSession: st.tmuxSession,
            cliAgent: st.cliAgent,
            repo: st.repoPath ? { name: st.repoName ?? 'repo', localPath: st.repoPath } : (currentPreferredRepo ?? undefined),
            createdAt: now,
            lastActivity: now,
          });
          sessionsToAttach.push(st.tmuxSession);
        } else {
          restoredTabs.push({
            id: tabId,
            label: st.label,
            kind: 'terminal',
            tmuxSession: null,
            cliAgent: 'shell',
            repo: st.repoPath ? { name: st.repoName ?? 'repo', localPath: st.repoPath } : (currentPreferredRepo ?? undefined),
            createdAt: now,
            lastActivity: now,
          });
        }
        if (st.id === saved.activeTabId) restoredActiveTabId = tabId;
      }

      // If the saved active tab was a canvas (file viewer), prefer a chat tab instead
      const restoredActiveTab = restoredActiveTabId
        ? restoredTabs.find((tab) => tab.id === restoredActiveTabId)
        : null;
      const effectiveRestoredActiveId = restoredActiveTab?.kind === 'canvas'
        ? null
        : restoredActiveTabId;

      let nextActiveId = '';
      if (defaultTab === 'llm-chat') {
        const restoredChat = restoredTabs.find((tab) => tab.kind === 'llm-chat');
        if (restoredChat) {
          nextActiveId = effectiveRestoredActiveId ?? restoredChat.id;
          tabsRef.current = restoredTabs;
          setTabs(restoredTabs);
          setActiveTabId(nextActiveId);
        } else if (restoredTabs.length > 0) {
          const restoredCliChat = restoredTabs.find((tab) => tab.kind === 'chat');
          nextActiveId = effectiveRestoredActiveId ?? restoredCliChat?.id ?? restoredTabs[0]?.id ?? '';
          tabsRef.current = restoredTabs;
          setTabs(restoredTabs);
          setActiveTabId(nextActiveId);
        } else {
          const defaultChat = createDefaultChatTab();
          const nextTabs = [defaultChat, ...restoredTabs];
          nextActiveId = defaultChat.id;
          tabsRef.current = nextTabs;
          setTabs(nextTabs);
          setActiveTabId(nextActiveId);
        }
      } else {
        const restoredCliChat = restoredTabs.find((tab) => tab.kind === 'chat');
        const restoredTerminal = restoredTabs.find((tab) => tab.kind === 'terminal');
        nextActiveId = effectiveRestoredActiveId ?? restoredCliChat?.id ?? restoredTerminal?.id ?? restoredTabs[0]?.id ?? '';
        tabsRef.current = restoredTabs;
        setTabs(restoredTabs);
        setActiveTabId(nextActiveId);
      }
      if (cancelled?.()) return false;

      if (termWsConnectedRef.current) {
        initialTerminalBootstrapRef.current = true;
        for (const sessionName of sessionsToAttach) {
          sendTerminalAttach(sessionName, 120, 30);
        }

        const deadTerminalTabs = restoredTabs.filter((t) => t.kind === 'terminal' && t.tmuxSession === null);
        for (const deadTab of deadTerminalTabs) {
          if (cancelled?.()) return false;
          const restoreCommand = deadTab.repo?.localPath ? `cd ${deadTab.repo.localPath}` : undefined;
          requestTerminalForTab(deadTab.id, restoreCommand);
        }
      } else {
        initialTerminalBootstrapRef.current = false;
      }
      return restoredTabs.length > 0;
    }, [createDefaultChatTab, defaultTab, requestTerminalForTab, sendTerminalAttach]);

    // Restore tabs on first page load, even before the workspace bridge reconnects.
    // This effect only re-runs when the tile scope actually changes (stateScope).
    // All other values (preferredRepo, restoreKey, autoCreateDefaultTab, etc.)
    // are read from refs at execution time so that async-resolving props
    // (like repos loading) don't cancel an in-flight restore via effect cleanup.
    useEffect(() => {
      if (restoredRef.current) return;
      restoredRef.current = true;
      restoreInFlightRef.current = true;
      let cancelled = false;

      // Suppress URL detection for 5s to skip replay of old terminal output
      urlDetectionEnabledRef.current = false;
      const urlDetectionTimer = window.setTimeout(() => { urlDetectionEnabledRef.current = true; }, 5000);

      (async () => {
        try {
          let saved = splitCreated ? null : await loadTabState(stateScope, null);
          if (cancelled) return;
          const currentPreferredRepoPath = preferredRepoRef.current?.localPath ?? null;
          const currentStableRepoScope = !splitCreated && currentPreferredRepoPath
            ? buildRepoStateScope(currentPreferredRepoPath)
            : null;
          const savedRepoPaths = saved
            ? Array.from(new Set(saved.tabs.map((tab) => tab.repoPath).filter((value): value is string => Boolean(value))))
            : [];
          const savedHasOrchestratedTabs = Boolean(saved?.tabs.some((tab) => tab.orchestrationPacket));
          const savedMatchesPreferredRepo = !currentPreferredRepoPath
            || savedRepoPaths.length === 0
            || savedRepoPaths.includes(currentPreferredRepoPath);

          if (
            !splitCreated
            && (!saved || saved.tabs.length === 0 || (!savedMatchesPreferredRepo && !savedHasOrchestratedTabs))
            && currentStableRepoScope
          ) {
            saved = await loadTabState(currentStableRepoScope, currentPreferredRepoPath);
            if (cancelled) return;
          }

          const currentRestoreKey = restoreKeyRef.current ?? `${stateScope}::${defaultTab}::${splitCreated ? 'split' : 'shared'}::${currentPreferredRepoPath ?? 'no-repo'}`;

          if (saved && saved.tabs.length > 0) {
            await applyPersistedState(saved, () => cancelled);
            if (cancelled) return;
            restoreInFlightRef.current = false;
            restoreSettledRef.current = true;
            setRestoreCompletedKey(currentRestoreKey);
          } else if (autoCreateDefaultTab) {
            if (cancelled) return;
            if (defaultTab === 'llm-chat') {
              const defaultChat = createDefaultChatTab();
              tabsRef.current = [defaultChat];
              setTabs([defaultChat]);
              setActiveTabId(defaultChat.id);
            } else {
              const defaultShell = createDefaultShellTab();
              tabsRef.current = [defaultShell];
              setTabs([defaultShell]);
              setActiveTabId(defaultShell.id);
              if (termWsConnectedRef.current) {
                initialTerminalBootstrapRef.current = true;
                requestTerminalForTab(defaultShell.id);
              }
            }
            restoreInFlightRef.current = false;
            restoreSettledRef.current = true;
            setRestoreCompletedKey(currentRestoreKey);
          } else {
            tabsRef.current = [];
            setTabs([]);
            setActiveTabId('');
            restoreInFlightRef.current = false;
            restoreSettledRef.current = true;
            setRestoreCompletedKey(currentRestoreKey);
          }
        } catch {
          restoreInFlightRef.current = false;
          if (cancelled) return;
          const currentRestoreKey = restoreKeyRef.current ?? stateScope;
          restoreSettledRef.current = true;
          setRestoreCompletedKey(currentRestoreKey);
        }
      })();
      return () => {
        cancelled = true;
        restoreInFlightRef.current = false;
        window.clearTimeout(urlDetectionTimer);
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Only re-run when the tile scope changes. All other values are read from refs at execution time to prevent effect cleanup from cancelling in-flight restores when async props (repos, preferred repo) resolve.
    }, [stateScope, splitCreated, defaultTab]);

    useEffect(() => {
      if (!termWsConnected || !restoreSettledRef.current || initialTerminalBootstrapRef.current) {
        return;
      }
      initialTerminalBootstrapRef.current = true;
      for (const tab of tabsRef.current) {
        if (tab.kind !== 'terminal') continue;
        if (tab.tmuxSession) {
          sendTerminalAttach(tab.tmuxSession, 120, 30);
          continue;
        }
        const restoreCommand = tab.repo?.localPath ? `cd ${tab.repo.localPath}` : undefined;
        requestTerminalForTab(tab.id, restoreCommand);
      }
    }, [requestTerminalForTab, sendTerminalAttach, termWsConnected]);

    useEffect(() => {
      if (tabs.length > 0 || !termWsConnected || splitCreated || !primaryRestoreSettled) return;
      const timer = window.setTimeout(() => {
        void (async () => {
          if (stableRepoScope && preferredRepo?.localPath) {
            const saved = await loadTabState(stableRepoScope, preferredRepo.localPath);
            if (saved && saved.tabs.length > 0) {
              const restored = await applyPersistedState(saved);
              if (restored) return;
            }
          }
          if (!autoCreateDefaultTab) {
            tabsRef.current = [];
            setTabs([]);
            setActiveTabId('');
            return;
          }
          if (defaultTab === 'llm-chat') {
            const fallbackChat = createDefaultChatTab();
            tabsRef.current = [fallbackChat];
            setTabs([fallbackChat]);
            setActiveTabId(fallbackChat.id);
            return;
          }
          const fallbackShell = createDefaultShellTab();
          tabsRef.current = [fallbackShell];
          setTabs([fallbackShell]);
          setActiveTabId(fallbackShell.id);
          if (termWsConnected) {
            requestTerminalForTab(fallbackShell.id);
          }
        })();
      }, 250);
      return () => window.clearTimeout(timer);
    }, [applyPersistedState, autoCreateDefaultTab, createDefaultChatTab, createDefaultShellTab, defaultTab, preferredRepo?.localPath, primaryRestoreSettled, requestTerminalForTab, splitCreated, stableRepoScope, tabs.length, termWsConnected]);

    // Safety net: if no tabs exist after 2s and we want a default chat,
    // create one. Catches edge cases where restore hangs or loads empty.
    useEffect(() => {
      if (tabs.length > 0 || defaultTab !== 'llm-chat') return;
      const timer = window.setTimeout(() => {
        if (tabsRef.current.length > 0) return;
        const fallback = createDefaultChatTab();
        tabsRef.current = [fallback];
        setTabs([fallback]);
        setActiveTabId(fallback.id);
      }, 2000);
      return () => window.clearTimeout(timer);
    }, [tabs.length, defaultTab, createDefaultChatTab]);

    // On reconnect, reattach existing terminal tabs without resetting chat state.
    useEffect(() => {
      const wasConnected = previousWsConnectedRef.current;
      previousWsConnectedRef.current = termWsConnected;
      if (!termWsConnected || !wasConnected || !restoredRef.current) {
        return;
      }
      for (const tab of tabsRef.current) {
        if (tab.kind === 'terminal' && tab.tmuxSession) {
          sendTerminalAttach(tab.tmuxSession, 120, 30);
        }
      }
    }, [sendTerminalAttach, termWsConnected]);

    // Called when WS server confirms a new tmux session was created
    const handleSessionCreated = useCallback((sessionName: string, requestId?: string) => {
      const directTabId = requestId ? pendingRequestRef.current.get(requestId) : undefined;
      if (requestId && !directTabId) {
        return false;
      }
      if (requestId) pendingRequestRef.current.delete(requestId);

      let claimed = false;
      setTabs(prev => {
        const pendingIdx = directTabId
          ? prev.findIndex(t => t.id === directTabId && t.kind === 'terminal' && t.tmuxSession === null)
          : prev.findIndex(t => t.kind === 'terminal' && t.tmuxSession === null);
        if (pendingIdx >= 0) {
          const updated = [...prev];
          const tab = updated[pendingIdx];
          updated[pendingIdx] = { ...tab, tmuxSession: sessionName };
          claimed = true;
          return updated;
        }
        return prev;
      });
      if (!claimed && requestId && directTabId) {
        sendTerminalDetach(sessionName);
      }
      return claimed;
    }, [sendTerminalDetach]);

	    const openWorkspaceCliChatSession = useCallback((options: {
	      runtime?: 'codex' | 'claude-code';
	      repo?: RegisteredRepo;
	      modelId?: string;
	      initialText?: string;
	      draftReason?: string;
	      autoSend?: boolean;
	      createNew?: boolean;
	      label?: string;
	      targetSessionKey?: string;
	      orchestrationPacket?: WorkspaceOrchestrationPacketBadge | null;
        supervisorStatus?: string | null;
        autoArchiveOnIdle?: boolean;
	    }) => {
      const currentTabs = tabsRef.current;
      const activeTab = currentTabs.find((tab) => tab.id === activeTabId);
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
        ?? (isAgentRuntimeTab(activeTab)
          ? activeTab.chatRuntime
          : (options.createNew ? 'codex' : 'claude-code'));
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
        tab.id === activeTabId
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
      const injection = options.initialText
        ? {
            id: `workspace-chat-injection-${Date.now()}`,
            text: options.initialText,
            reason: options.draftReason,
            autoSend: options.autoSend,
          }
        : undefined;

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
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        setActiveTabId(resolvedTabId);
        persistTabsNow(nextTabs, resolvedTabId);
        return resolvedTabId;
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
      const nextTabs = [...currentTabs, newTab];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveTabId(resolvedTabId);
      persistTabsNow(nextTabs, resolvedTabId);
      return resolvedTabId;
    }, [activeTabId, persistTabsNow]);

    const openWorkspaceLlmChatSession = useCallback((options: {
      repo?: RegisteredRepo;
      initialText?: string;
      draftReason?: string;
      autoSend?: boolean;
      createNew?: boolean;
      label?: string;
      targetSessionKey?: string;
    }) => {
      const currentTabs = tabsRef.current;
      const targetTabId = options.targetSessionKey?.startsWith('llm-chat:')
        ? options.targetSessionKey.slice('llm-chat:'.length)
        : null;

      const activeExisting = currentTabs.find((tab) => (
        tab.id === activeTabId
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
      const injection = options.initialText
        ? {
            id: `workspace-llm-injection-${Date.now()}`,
            text: options.initialText,
            reason: options.draftReason,
            autoSend: options.autoSend,
          }
        : undefined;

      if (matchingExisting) {
        const resolvedTabId = matchingExisting.id;
        setTabs((prev) => prev.map((tab) => (
          tab.id === resolvedTabId
            ? {
                ...tab,
                label: options.label ?? tab.label,
                llmDraftInjection: injection ?? tab.llmDraftInjection,
              }
            : tab
        )));
        setActiveTabId(resolvedTabId);
        return resolvedTabId;
      }

      const resolvedTabId = generateLlmChatTabId();
      const now = Date.now();
      const newTab: TerminalTab = {
        id: resolvedTabId,
        label: options.label ?? 'Chat',
        kind: 'llm-chat',
        tmuxSession: null,
        repo: options.repo,
        linkedIssue: null,
        llmDraftInjection: injection,
        createdAt: now,
        lastActivity: now,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(resolvedTabId);
      return resolvedTabId;
    }, [activeTabId]);

    const openWorkspaceInspectorTab = useCallback((canvasTab: CanvasTab, options?: {
      repo?: RegisteredRepo;
      createNew?: boolean;
    }) => {
      const currentTabs = tabsRef.current;
      const matchingExisting = options?.createNew
        ? null
        : currentTabs.find((tab) => (
            tab.kind === 'canvas'
            && tab.canvasTab?.id === canvasTab.id
            && (options?.repo ? tab.repo?.localPath === options.repo.localPath : true)
          ));

      if (matchingExisting) {
        const resolvedTabId = matchingExisting.id;
        setTabs((prev) => prev.map((tab) => (
          tab.id === resolvedTabId
            ? {
                ...tab,
                label: canvasTab.label,
                canvasTab,
                repo: options?.repo ?? tab.repo,
                lastActivity: Date.now(),
              }
            : tab
        )));
        setActiveTabId(resolvedTabId);
        return resolvedTabId;
      }

      const resolvedTabId = createWorkspaceTabId('canvas');
      const now = Date.now();
      const newTab: TerminalTab = {
        id: resolvedTabId,
        label: canvasTab.label,
        kind: 'canvas',
        tmuxSession: null,
        repo: options?.repo,
        canvasTab,
        createdAt: now,
        lastActivity: now,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(resolvedTabId);
      return resolvedTabId;
    }, []);

    const handleOpenWorkspaceCommitTab = useCallback((hash: string, meta?: Record<string, string>, repo?: RegisteredRepo) => {
      const nextMeta: Record<string, string> = { ...(meta ?? {}) };
      if (!nextMeta.workspace && repo?.localPath) {
        nextMeta.workspace = repo.localPath;
      }
      const repoSlug = repoSlugFromRemote(repo?.remoteUrl);
      if (!nextMeta.repo && repoSlug) {
        nextMeta.repo = repoSlug;
      }

      openWorkspaceInspectorTab({
        id: `commit:${hash}:${nextMeta.workspace ?? 'default'}`,
        kind: 'commit',
        label: hash.slice(0, 7),
        resourceId: hash,
        meta: Object.keys(nextMeta).length > 0 ? nextMeta : undefined,
      }, {
        repo,
      });
    }, [openWorkspaceInspectorTab]);

    // Route terminal events to the correct tab's XtermPanel
    useImperativeHandle(ref, () => ({
      writeToTerminal: (sessionName: string, data: string) => {
        panelRefs.current.get(sessionName)?.writeData(data);
        // Track activity for the live dot
        const now = Date.now();
        setTabs(prev => prev.map(t =>
          t.tmuxSession === sessionName ? { ...t, lastActivity: now } : t
        ));

        // Scan for localhost URLs (skip during first 5s to ignore replayed history)
        if (urlDetectionEnabledRef.current) try {
          // Decode base64 → bytes → UTF-8 string for reliable regex matching
          const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
          const raw = new TextDecoder().decode(bytes);
          const clean = raw.replace(ANSI_RE, '');
          // Reset regex lastIndex (global regex retains state)
          LOCALHOST_RE.lastIndex = 0;
          const matches = clean.matchAll(LOCALHOST_RE);
          for (const match of matches) {
            const port = parseInt(match[1], 10);
            console.log(`[terminal] Detected localhost:${port} → ${match[0]}`);
            if (IGNORED_PORTS.has(port)) { console.log(`[terminal] Skipping port ${port} (IDE port)`); continue; }
            if (detectedPortsRef.current.has(port)) { console.log(`[terminal] Skipping port ${port} (already detected)`); continue; }
            detectedPortsRef.current.add(port);

            // Find which tab this session belongs to
            const tab = tabsRef.current.find(t => t.tmuxSession === sessionName);
            let url = match[0].replace('0.0.0.0', 'localhost');
            // Ensure http:// prefix
            if (!url.startsWith('http')) url = `http://${url}`;

            const newPreview: LocalhostPreview = {
              id: `preview-${port}`,
              tabId: tab?.id ?? '',
              url,
              port,
              detectedAt: now,
            };
            console.log(`[terminal] Adding preview:`, newPreview);
            onPreviewDetected?.(newPreview);
            setPreviews(prev => {
              if (prev.some(p => p.port === port)) return prev;
              const updated = [...prev, newPreview];
              console.log(`[terminal] Previews now:`, updated.length);
              return updated;
            });
          }
        } catch { /* ignore decode errors */ }
      },
      writeRaw: (sessionName: string, data: string) => {
        panelRefs.current.get(sessionName)?.writeRaw(data);
      },
      showImage: (sessionName: string, imageB64: string, filename: string) => {
        panelRefs.current.get(sessionName)?.showImage(imageB64, filename);
      },
      setTermError: (sessionName: string, error: string) => {
        panelRefs.current.get(sessionName)?.setError(error);
      },
      setTermExited: (sessionName: string) => {
        panelRefs.current.get(sessionName)?.setExited();
      },
      onSessionCreated: handleSessionCreated,
      clearDetectedPreview: (port: number) => {
        detectedPortsRef.current.delete(port);
        setPreviews((prev) => prev.filter((preview) => preview.port !== port));
      },
      isRestoreSettled: () => restoreSettledRef.current,
      openCliChatSession: (options) => openWorkspaceCliChatSession(options),
	      injectIntoCliChat: (text, options) => (
	        options?.targetSessionKey?.startsWith('llm-chat:')
	          ? openWorkspaceLlmChatSession({
              repo: options?.repo,
              initialText: text,
              autoSend: options?.autoSend ?? false,
              createNew: options?.createNew ?? false,
              label: options?.label,
              draftReason: options?.draftReason,
              targetSessionKey: options?.targetSessionKey,
            })
	          : openWorkspaceCliChatSession({
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
	        const exists = tabsRef.current.some((tab) => tab.id === tabId);
	        if (!exists) return false;
	        setActiveTabId(tabId);
          persistTabsNow(tabsRef.current, tabId);
	        return true;
	      },
	      setOrchestrationPacket: (tabId, packet) => {
	        let found = false;
	        setTabs((prev) => prev.map((tab) => {
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
          setTabs((prev) => prev.map((tab) => {
            if (tab.kind !== 'chat') return tab;
            const currentSessionKey = normalizeWorkspaceChatSessionKey(tab.chatRuntime, tab.chatSessionKey);
            if (!currentSessionKey || currentSessionKey !== normalizedTarget) return tab;
            found = true;
            const nextStatus = status.trim();
            const statusChanged = (tab.supervisorStatus ?? '') !== nextStatus;
            const nextPacketStatus = packetStatusFromSupervisorStatus(nextStatus, tab.orchestrationPacket?.status ?? null);
            const packetChanged = nextPacketStatus !== (tab.orchestrationPacket?.status ?? null);
            return {
              ...tab,
              label: label ?? tab.label,
              supervisorStatus: nextStatus,
              autoArchiveOnIdle: tab.autoArchiveOnIdle ?? true,
              orchestrationPacket: tab.orchestrationPacket
                ? {
                    ...tab.orchestrationPacket,
                    status: nextPacketStatus ?? tab.orchestrationPacket.status,
                  }
                : tab.orchestrationPacket,
              lastActivity: statusChanged || packetChanged ? Date.now() : tab.lastActivity,
            };
          }));
          return found;
        },
	      getChatTabSnapshots: () => (
	        tabsRef.current
	          .filter(isAgentRuntimeTab)
	          .map((tab) => ({
	            tileId: stateScope,
	            tabId: tab.id,
	            label: tab.label,
	            runtime: tab.chatRuntime,
	            sessionKey: normalizeWorkspaceChatSessionKey(tab.chatRuntime, tab.chatSessionKey),
	            repoPath: tab.repo?.localPath ?? preferredRepo?.localPath ?? null,
	            branch: tab.repo?.branch ?? preferredRepo?.branch ?? null,
	            status: resolveWorkspaceChatLaneStatus(tab) === 'running' ? 'running' : 'idle',
	            lastActivityAt: new Date(tab.lastActivity).toISOString(),
	            packetId: tab.orchestrationPacket?.packetId ?? null,
	          }))
	      ),
	      openWorkspaceDiff: () => {
	        const activeWorkspaceTab = tabsRef.current.find((tab) => tab.id === activeTabId);
	        const repo = activeWorkspaceTab?.repo ?? tabsRef.current.find((tab) => tab.repo)?.repo ?? preferredRepo ?? null;
	        onOpenRepoDiff?.(repo);
	      },
      openInspectorTab: (canvasTab, options) => openWorkspaceInspectorTab(canvasTab, options),
	    }), [activeTabId, handleSessionCreated, onOpenRepoDiff, onPreviewDetected, openWorkspaceCliChatSession, openWorkspaceInspectorTab, openWorkspaceLlmChatSession, persistTabsNow, preferredRepo, stateScope]);

    // Auto-register a folder so it shows in the picker next time
    const handleRegisterRepo = useCallback((localPath: string) => {
      fetch('/api/panel/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', localPath }),
      }).catch(() => { /* silently fail — non-critical */ });
    }, []);

    const handleNewTab = useCallback((agentId: string, repo?: RegisteredRepo) => {
      const agent = CLI_AGENTS.find(a => a.id === agentId);
      if (!agent) return;

      const tabId = createWorkspaceTabId('terminal');
      const label = agent.label;
      const now = Date.now();
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

      // Queue CLI command + optional cd to repo
      if (agent.command || repo) {
        const parts: string[] = [];
        if (repo) parts.push(`cd ${repo.localPath}`);
        if (agent.command) parts.push(agent.command);
        pendingCliCommands.current.set(tabId, parts.join(' && '));
      }

      setTabs(prev => [...prev, newTab]);
      setActiveTabId(tabId);
      requestTerminalForTab(tabId, pendingCliCommands.current.get(tabId));
    }, [requestTerminalForTab]);

    const handleNewChatTab = useCallback((runtime: 'codex' | 'claude-code', repo?: RegisteredRepo) => {
      const tabId = createWorkspaceTabId('chat');
      const label = adHocLaneTitle('chat');
      const now = Date.now();
      const newTab: TerminalTab = {
        id: tabId,
        label,
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
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(tabId);
    }, []);

    const handleNewLLMChatTab = useCallback((repo?: RegisteredRepo) => {
      const tabId = generateLlmChatTabId();
      const now = Date.now();
      const newTab: TerminalTab = {
        id: tabId,
        label: adHocLaneTitle('llm-chat'),
        kind: 'llm-chat',
        tmuxSession: null,
        repo: repo ?? preferredRepo ?? undefined,
        linkedIssue: null,
        createdAt: now,
        lastActivity: now,
      };
      setTabs(prev => {
        const nextTabs = [...prev, newTab];
        // Persist immediately — the debounced effect may not fire before a reload
        persistTabsNow(nextTabs, tabId);
        return nextTabs;
      });
      setActiveTabId(tabId);
    }, [persistTabsNow, preferredRepo]);

    const handleUpdateChatMessages = useCallback((tabId: string, messages: MobileTranscriptEntry[]) => {
      setTabs((prev) => prev.map((tab) => {
        if (tab.id !== tabId) return tab;
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
      }));
    }, []);

    const handleUpdateLlmSummary = useCallback((tabId: string, summary: string | null) => {
      setTabs(prev => {
        let changed = false;
        const next = prev.map((tab) => {
          if (tab.id !== tabId || tab.llmSummary === summary) {
            return tab;
          }
          changed = true;
          return { ...tab, llmSummary: summary };
        });
        return changed ? next : prev;
      });
    }, []);

    const handleUpdateChatSessionKey = useCallback((tabId: string, sessionKey: string) => {
      setTabs((prev) => prev.map((tab) => (
        tab.id === tabId
          ? {
              ...tab,
              chatSessionKey: tab.chatRuntime
                ? (normalizeWorkspaceChatSessionKey(tab.chatRuntime, sessionKey) ?? sessionKey)
                : sessionKey,
            }
          : tab
      )));
    }, []);

    const handleUpdateChatModel = useCallback((tabId: string, modelId: string) => {
      setTabs(prev => prev.map(t =>
        t.id === tabId ? { ...t, chatModel: modelId } : t
      ));
    }, []);

    const handleUpdateLinkedIssue = useCallback((tabId: string, linkedIssue: LinkedIssueRef | null) => {
      setTabs(prev => prev.map(t =>
        t.id === tabId ? { ...t, linkedIssue } : t
      ));
    }, []);

    const handleSaveCheckpoint = useCallback((tabId: string) => {
      setTabs((prev) => prev.map((tab) => {
        if (tab.id !== tabId || tab.kind !== 'chat') return tab;
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
      }));
    }, []);

    const handleRestoreLatestCheckpoint = useCallback((tabId: string) => {
      let nextActiveTabId = '';
      setTabs((prev) => {
        const sourceTab = prev.find((tab) => tab.id === tabId && tab.kind === 'chat');
        const checkpoint = sourceTab?.chatCheckpoints?.[0];
        if (!sourceTab || !checkpoint) return prev;

        const nextTabId = createWorkspaceTabId('chat');
        nextActiveTabId = nextTabId;
        const now = Date.now();
        const recoveryNote = [
          `Resume from checkpoint "${checkpoint.label}".`,
          'Use this saved transcript point as the last known safe state.',
          'Re-establish the plan from the preserved context before making new edits.',
        ].join('\n\n');

        const restoredTab: TerminalTab = {
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
        };
        return [...prev, restoredTab];
      });
      if (nextActiveTabId) {
        setActiveTabId(nextActiveTabId);
      }
    }, []);

    const handleConsumeChatDraftInjection = useCallback((tabId: string, injectionId: string) => {
      setTabs(prev => prev.map((tab) => (
        tab.id === tabId && tab.chatDraftInjection?.id === injectionId
          ? { ...tab, chatDraftInjection: undefined }
          : tab
      )));
    }, []);

    const handleConsumeLlmDraftInjection = useCallback((tabId: string, injectionId: string) => {
      setTabs(prev => prev.map((tab) => (
        tab.id === tabId && tab.llmDraftInjection?.id === injectionId
          ? { ...tab, llmDraftInjection: undefined }
          : tab
      )));
    }, []);

    const handleRunCommandInTerminal = useCallback((command: string) => {
      const shellTab = tabs.find(t => t.kind === 'terminal' && t.tmuxSession);
      if (shellTab?.tmuxSession) {
        sendTerminalInput(shellTab.tmuxSession, command + '\n');
        return;
      }

      const pendingShell = tabs.find(t => t.kind === 'terminal' && !t.tmuxSession);
      if (pendingShell) {
        pendingCliCommands.current.set(pendingShell.id, command);
        setActiveTabId(pendingShell.id);
        return;
      }

      const nextTabId = createWorkspaceTabId('terminal');
      const now = Date.now();
      const newTab: TerminalTab = {
        id: nextTabId,
        label: 'Terminal',
        kind: 'terminal',
        tmuxSession: null,
        cliAgent: 'shell',
        createdAt: now,
        lastActivity: now,
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(nextTabId);
      requestTerminalForTab(nextTabId, command);
    }, [requestTerminalForTab, sendTerminalInput, tabs]);

    const handleCloseTab = useCallback((tabId: string) => {
      setTabs(prev => {
        const idx = prev.findIndex(t => t.id === tabId);
        if (idx < 0) return prev;
        const tab = prev[idx];
        // Detach from tmux
        if (tab.tmuxSession) {
          sendTerminalDetach(tab.tmuxSession);
          panelRefs.current.delete(tab.tmuxSession);
        }
        pendingCliCommands.current.delete(tabId);
        for (const [requestId, pendingTabId] of pendingRequestRef.current) {
          if (pendingTabId === tabId) pendingRequestRef.current.delete(requestId);
        }
        const remaining = prev.filter(t => t.id !== tabId);
        // If closing active tab, switch to adjacent
        if (tabId === activeTabId && remaining.length > 0) {
          const newIdx = Math.min(idx, remaining.length - 1);
          setActiveTabId(remaining[newIdx].id);
        } else if (tabId === activeTabId && remaining.length === 0) {
          setActiveTabId('');
        }
        // Remove any previews associated with this tab
        setPreviews(prev => {
          const toRemove = prev.filter(p => p.tabId === tabId);
          toRemove.forEach(p => detectedPortsRef.current.delete(p.port));
          return prev.filter(p => p.tabId !== tabId);
        });

        return remaining;
      });
    }, [activeTabId, sendTerminalDetach]);

    const archiveWorkspaceTab = useCallback((tabId: string, packetId?: string | null) => {
      handleCloseTab(tabId);
      if (!packetId) return;
      const currentMissionState = readOrchestratorMissionState();
      const packet = currentMissionState.packets.find((entry) => entry.id === packetId);
      if (!packet || packet.archivedAt) return;
      void persistOrchestratorMissionState({
        ...currentMissionState,
        packets: currentMissionState.packets.map((entry) => (
          entry.id === packetId
            ? { ...entry, archivedAt: new Date().toISOString() }
            : entry
        )),
      });
    }, [handleCloseTab]);

    useEffect(() => {
      const timers = new Map<string, number>();
      const now = Date.now();
      for (const tab of tabs) {
        if (tab.kind !== 'chat' || !tab.autoArchiveOnIdle) continue;
        if (tab.id === effectiveActiveTabId) continue;
        const laneStatus = resolveWorkspaceChatLaneStatus(tab);
        const eligible = laneStatus === 'awaiting_review'
          || laneStatus === 'idle'
          || laneStatus === 'released'
          || tab.supervisorStatus?.trim().toLowerCase() === 'completed'
          || tab.supervisorStatus?.trim().toLowerCase() === 'failed';
        if (!eligible) continue;
        const idleForMs = Math.max(0, now - tab.lastActivity);
        const delayMs = Math.max(0, ORCHESTRATED_TAB_AUTO_ARCHIVE_MS - idleForMs);
        const timerId = window.setTimeout(() => {
          archiveWorkspaceTab(tab.id, tab.orchestrationPacket?.packetId ?? null);
        }, delayMs);
        timers.set(tab.id, timerId);
      }
      return () => {
        timers.forEach((timerId) => window.clearTimeout(timerId));
      };
    }, [archiveWorkspaceTab, effectiveActiveTabId, tabs]);

    // When a tab gets its tmux session, run pending CLI command via tmux send-keys (server-side)
    useEffect(() => {
      for (const tab of tabs) {
        if (tab.tmuxSession && pendingCliCommands.current.has(tab.id)) {
          const command = pendingCliCommands.current.get(tab.id)!;
          pendingCliCommands.current.delete(tab.id);
          // Use server-side API to run command via tmux send-keys (doesn't race with terminal rendering)
          fetch('/api/panel/terminal-exec', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionName: tab.tmuxSession, command }),
          }).catch(() => {
            // Fallback: send through WS input after longer delay
            setTimeout(() => {
              sendTerminalInput(tab.tmuxSession!, command + '\n');
            }, 2000);
          });
        }
      }
    }, [tabs, sendTerminalInput]);

    // Drag resize state
    const [previewHeight, setPreviewHeight] = useState(0.55); // 55% default for preview
    const [isDragging, setIsDragging] = useState(false);
    const [launchRequestKey, setLaunchRequestKey] = useState(0);
    const containerDivRef = useRef<HTMLDivElement>(null);
	    const activeTab = useMemo(
	      () => visibleTabs.find((tab) => tab.id === effectiveActiveTabId) ?? null,
	      [effectiveActiveTabId, visibleTabs],
	    );
	    const activeCheckpoint = activeTab?.kind === 'chat' ? activeTab.chatCheckpoints?.[0] : null;
	    const activeOrchestrationPacket = activeTab?.orchestrationPacket ?? null;
	    const activeOrchestrationTone = activeOrchestrationPacket
	      ? orchestratorStatusTone(activeOrchestrationPacket.status)
	      : activeManualLaneStatus(activeTab);

    const handleDragStart = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);

      const onMove = (ev: MouseEvent) => {
        if (!containerDivRef.current) return;
        const rect = containerDivRef.current.getBoundingClientRect();
        const ratio = (ev.clientY - rect.top) / rect.height;
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
    }, []);

    const hasPreviews = showPreviewPane && previews.length > 0;
    const paneRepoPaths = useMemo(() => {
      const repoPaths = visibleTabs.map((tab) => tab.repo?.localPath).filter((value): value is string => Boolean(value));
      if (repoPaths.length > 0) {
        return Array.from(new Set(repoPaths));
      }
      return preferredRepo?.localPath ? [preferredRepo.localPath] : [];
    }, [preferredRepo, visibleTabs]);
    const paneHasMixedRepos = paneRepoPaths.length > 1;
    const activeRepo = activeTab?.repo ?? visibleTabs.find((tab) => tab.repo)?.repo ?? preferredRepo ?? null;
    const headerRepo = activeRepo ?? preferredRepo ?? null;
    const activeLaneState = useMemo(
      () => buildWorkspaceLaneState(stateScope, activeTab, preferredRepo ?? null),
      [activeTab, preferredRepo, stateScope],
    );
    useEffect(() => {
      onActiveLaneChange?.(activeLaneState);
    }, [activeLaneState, onActiveLaneChange]);
    const isFreshSplitShell = splitCreated
      && visibleTabs.length === 1
      && activeTab?.kind === 'terminal'
      && activeTab.label === 'Shell';
    const headerLaneTitle = activeTab
      ? laneDisplayTitle(activeOrchestrationPacket, activeTab.kind)
      : 'Workspace lane';
    const headerContextTitle = isFreshSplitShell && headerRepo
      ? `${headerRepo.name} · ${headerRepo.branch ?? 'main'}`
      : isFreshSplitShell
        ? 'Choose a repo or worktree'
      : headerRepo?.isWorktree
        ? `${headerRepo.name} · ${headerRepo.branch ?? headerRepo.name}`
      : headerRepo
        ? shortenPath(headerRepo.localPath)
        : paneHasMixedRepos
          ? `${paneRepoPaths.length} repos in this pane`
          : `${paneRepoPaths.length} repos across these tabs`;
    const headerContextSubtitle = headerRepo?.isWorktree
      ? `${shortenPath(headerRepo.localPath)} · ${headerRepo.worktreeStatus ?? 'workspace'}`
      : headerRepo
        ? `${headerRepo.name} · ${activeRepo?.branch ?? headerRepo.branch ?? 'main'}`
        : isFreshSplitShell
          ? 'Ready for a new lane'
          : null;
    const activeRuntimeTone = activeOrchestrationPacket
      ? orchestratorRuntimeTone(activeOrchestrationPacket.runtime)
      : manualLaneRuntimeTone(activeTab);
    const activeRepoDetails = useMemo(() => {
      if (!headerRepo) return null;
      return {
        branch: activeRepo?.branch ?? headerRepo.branch ?? preferredRepo?.branch ?? null,
        readiness: activeRepo?.readiness ?? headerRepo.readiness ?? preferredRepo?.readiness ?? null,
        remoteUrl: activeRepo?.remoteUrl ?? headerRepo.remoteUrl ?? preferredRepo?.remoteUrl,
      };
    }, [activeRepo, headerRepo, preferredRepo]);
    const activeRepoContext = useMemo<RegisteredRepo | null>(() => {
      if (!headerRepo) return null;
      return {
        ...headerRepo,
        branch: activeRepoDetails?.branch ?? headerRepo.branch ?? null,
        readiness: activeRepoDetails?.readiness ?? headerRepo.readiness ?? null,
        remoteUrl: activeRepoDetails?.remoteUrl ?? headerRepo.remoteUrl,
      };
    }, [activeRepoDetails, headerRepo]);
    const selectableRepos = useMemo(() => {
      if (availableRepos.length > 0) return availableRepos;
      return preferredRepo ? [preferredRepo] : [];
    }, [availableRepos, preferredRepo]);
    useEffect(() => {
      if (!containerDivRef.current) return undefined;
      const root = containerDivRef.current;
      const syncHelperNames = () => {
        const helperTextareas = Array.from(root.querySelectorAll<HTMLTextAreaElement>('.xterm-helper-textarea'));
        helperTextareas.forEach((textarea, index) => {
          if (!textarea.getAttribute('name')) {
            textarea.setAttribute('name', `workspaceTerminalInput-${stateScope}-${index}`);
          }
        });
      };
      syncHelperNames();
      const observer = new MutationObserver(() => {
        syncHelperNames();
      });
      observer.observe(root, { childList: true, subtree: true });
      return () => observer.disconnect();
    }, [stateScope]);
    useEffect(() => {
      const nextRepoScope = activeRepo?.localPath ?? preferredRepo?.localPath ?? null;
      if (reportedRepoScopeRef.current === nextRepoScope) {
        return;
      }
      reportedRepoScopeRef.current = nextRepoScope;
      onRepoScopeChange?.(nextRepoScope);
    }, [activeRepo?.localPath, onRepoScopeChange, preferredRepo?.localPath]);
    useEffect(() => {
      onActiveRepoContextChange?.(activeRepoContext);
    }, [activeRepoContext, onActiveRepoContextChange]);

    return (
      <div ref={containerDivRef} data-vibrancy-passthrough="" style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--t-bg-gradient)',
      }}>
        {/* Localhost preview pane — slides in when dev servers detected */}
        {hasPreviews && (
          <div style={{
            height: `${previewHeight * 100}%`,
            minHeight: 120,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            flexShrink: 0,
            animation: 'slide-in-preview 300ms ease-out',
            pointerEvents: isDragging ? 'none' : 'auto', // prevent iframe stealing mouse during drag
          }}>
            <PreviewPane
              previews={previews}
              onElementSelect={onPreviewSelection}
              onRefresh={() => {}}
              onClose={(id) => {
                setPreviews(prev => {
                  const removed = prev.find(p => p.id === id);
                  if (removed) detectedPortsRef.current.delete(removed.port);
                  return prev.filter(p => p.id !== id);
                });
              }}
            />
          </div>
        )}

        {/* Drag handle between preview and terminal */}
        {hasPreviews && (
          <div
            onMouseDown={handleDragStart}
            style={{
              height: 8,
              cursor: 'row-resize',
              background: isDragging ? THEME_ACCENT_SOFT_STRONG : 'var(--t-divider)',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 20,
              position: 'relative',
            }}
          >
            <div style={{
              width: 32,
              height: 3,
              borderRadius: 2,
              background: isDragging ? THEME_ACCENT : 'var(--t-text-muted)',
            }} />
          </div>
        )}

        {/* Tab bar — stays with the terminal */}
        {!termWsConnected ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              justifyContent: 'space-between',
              padding: '8px 12px',
              borderBottom: '1px solid rgba(245, 158, 11, 0.16)',
              background: 'rgba(245, 158, 11, 0.08)',
              color: '#b45309',
              fontSize: 12,
              lineHeight: 1.45,
              flexShrink: 0,
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              Reconnecting to the workspace runtime. Saved tabs stay in place and sessions reattach automatically when the bridge returns.
            </span>
            {activeTab?.kind === 'chat' && activeCheckpoint ? (
              <button
                type="button"
                onClick={() => handleRestoreLatestCheckpoint(activeTab.id)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  border: 'none',
                  borderRadius: 999,
                  background: 'rgba(37, 99, 235, 0.12)',
                  color: '#1d4ed8',
                  padding: '4px 8px',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  flexShrink: 0,
                }}
              >
                <RotateCcw size={11} />
                Restore latest checkpoint
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                border: 'none',
                borderRadius: 999,
                background: 'rgba(180, 83, 9, 0.12)',
                color: '#92400e',
                padding: '4px 8px',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 700,
                fontFamily: '-apple-system, system-ui, sans-serif',
                flexShrink: 0,
              }}
            >
              Reload workspace
            </button>
          </div>
        ) : null}


        <TabBar
          tabs={visibleTabs}
          activeTabId={effectiveActiveTabId}
          launchRequestKey={launchRequestKey}
          onSelectTab={setActiveTabId}
          onCloseTab={handleCloseTab}
          onNewTab={handleNewTab}
          onNewChatTab={handleNewChatTab}
          onNewLLMChatTab={handleNewLLMChatTab}
          scopedRepo={preferredRepo ?? activeRepo ?? null}
          onRegisterRepo={handleRegisterRepo}
          onSplitVertical={onSplitVertical}
          onSplitHorizontal={onSplitHorizontal}
          canCloseTile={canCloseTile}
          onCloseTile={onCloseTile}
        />

        {/* Terminal panels — all mounted, only active is visible */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#fff' }}>
          {visibleTabs.map((tab) => (
            tab.kind === 'llm-chat' ? (
              <div key={tab.id} style={{
                flex: 1,
                display: tab.id === effectiveActiveTabId ? 'flex' : 'none',
                flexDirection: 'column',
                height: '100%',
              }}>
                <LLMChat
                  tabId={tab.id}
                  preferredRepo={tab.repo ?? null}
                  linkedIssue={tab.linkedIssue ?? null}
                  draftInjection={tab.llmDraftInjection ?? null}
                  onSummaryChange={handleUpdateLlmSummary}
                  onConsumeDraftInjection={(injectionId) => handleConsumeLlmDraftInjection(tab.id, injectionId)}
                  onLinkedIssueChange={(issue) => handleUpdateLinkedIssue(tab.id, issue)}
                  onOpenHistoryChat={(historyTabId: string, title: string, historyRepo) => {
                    // Create a new tab that loads the history
                    const now = Date.now();
                    const newTab: TerminalTab = {
                      id: historyTabId,
                      label: title.slice(0, 20) + (title.length > 20 ? '...' : ''),
                      kind: 'llm-chat',
                      tmuxSession: null,
                      repo: historyRepo?.localPath || historyRepo?.name
                        ? {
                            name: historyRepo?.name ?? tab.repo?.name ?? 'repo',
                            localPath: historyRepo?.localPath ?? tab.repo?.localPath ?? '',
                            branch: historyRepo?.branch ?? tab.repo?.branch ?? null,
                            remoteUrl: historyRepo?.remoteUrl ?? tab.repo?.remoteUrl,
                          }
                        : tab.repo,
                      linkedIssue: tab.linkedIssue ?? null,
                      createdAt: now,
                      lastActivity: now,
                    };
                    setTabs(prev => {
                      // Don't create duplicate tabs
                      if (prev.some(t => t.id === historyTabId)) {
                        setActiveTabId(historyTabId);
                        return prev;
                      }
                      return [...prev, newTab];
                    });
                    setActiveTabId(historyTabId);
                  }}
                  onRunInTerminal={handleRunCommandInTerminal}
                />
              </div>
            ) : tab.kind === 'chat' ? (
              <div key={tab.id} style={{
                flex: 1,
                display: tab.id === effectiveActiveTabId ? 'flex' : 'none',
                flexDirection: 'column',
                height: '100%',
                minHeight: 0,
              }}>
                <WorkspaceChatPane
                  tab={tab}
                  active={tab.id === effectiveActiveTabId}
                  onUpdateMessages={handleUpdateChatMessages}
                  onUpdateSessionKey={handleUpdateChatSessionKey}
                  onRunInTerminal={handleRunCommandInTerminal}
                  onSelectModel={handleUpdateChatModel}
                  onConsumeDraftInjection={handleConsumeChatDraftInjection}
                  onLinkedIssueChange={handleUpdateLinkedIssue}
                  onSaveCheckpoint={handleSaveCheckpoint}
                  onRestoreLatestCheckpoint={handleRestoreLatestCheckpoint}
                />
              </div>
            ) : tab.kind === 'canvas' && tab.canvasTab ? (
              <div
                key={tab.id}
                style={{
                  flex: 1,
                  display: tab.id === effectiveActiveTabId ? 'flex' : 'none',
                  flexDirection: 'column',
                  height: '100%',
                  minHeight: 0,
                  overflow: 'hidden',
                }}
              >
                <Canvas
                  tabs={[tab.canvasTab]}
                  activeTabId={tab.canvasTab.id}
                  onSelectTab={() => undefined}
                  onCloseTab={() => handleCloseTab(tab.id)}
                  selectedRepo={repoSlugFromRemote(tab.repo?.remoteUrl) ?? null}
                  onInjectChatContext={onInjectChatContext}
                  onSelectCommit={(hash, meta) => {
                    if (tab.repo || meta?.workspace) {
                      handleOpenWorkspaceCommitTab(hash, meta, tab.repo);
                      return;
                    }
                    onSelectCommit?.(hash, meta);
                  }}
                  onLaunchWorkspaceTask={onLaunchWorkspaceTask}
                  embedded
                />
              </div>
            ) : tab.tmuxSession ? (
              <XtermPanel
                key={tab.tmuxSession}
                ref={(handle) => {
                  if (handle) panelRefs.current.set(tab.tmuxSession!, handle);
                  else panelRefs.current.delete(tab.tmuxSession!);
                }}
                tmuxSession={tab.tmuxSession}
                sendTerminalAttach={sendTerminalAttach}
                sendTerminalInput={sendTerminalInput}
                sendTerminalResize={sendTerminalResize}
                sendTerminalDetach={sendTerminalDetach}
                visible={tab.id === effectiveActiveTabId}
              />
            ) : (
              <div
                key={tab.id}
                style={{
                  flex: 1,
                  display: tab.id === effectiveActiveTabId ? 'flex' : 'none',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--t-text-muted)',
                  fontSize: 13,
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  flexDirection: 'column',
                  gap: 8,
                  textAlign: 'center',
                  padding: 24,
                }}
              >
                <TerminalIcon size={14} />
                <div style={{ fontWeight: 600, color: 'var(--t-text-secondary)' }}>
                  {termWsConnected ? 'Starting workspace lane…' : 'Waiting for the workspace bridge…'}
                </div>
                <div style={{ fontSize: 12, lineHeight: 1.5, maxWidth: 420 }}>
                  {tab.repo?.localPath
                    ? `Restoring ${tab.repo.name} in ${shortenPath(tab.repo.localPath)} and replaying the saved repo context.`
                    : 'This tab will attach automatically as soon as the runtime is available.'}
                </div>
              </div>
            )
          ))}

          {/* Empty state when no tabs */}
          {visibleTabs.length === 0 && (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 24,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 12,
                  textAlign: 'center',
                  maxWidth: 320,
                }}
              >
                <div
                  style={{
                    width: 40,
                    height: 40,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 12,
                    background: 'rgba(148, 163, 184, 0.08)',
                    color: 'var(--t-text-muted)',
                  }}
                >
                  <TerminalIcon size={18} />
                </div>
                <div style={{ color: 'var(--t-text-muted)', fontSize: 14, fontWeight: 600 }}>
                  Workspace surface idle
                </div>
                <div style={{ color: 'var(--t-text-muted)', fontSize: 12, lineHeight: 1.5 }}>
                  Open a terminal, chat, or canvas in this workspace. The shell can stay active in the background even when no terminal tab is open.
                </div>
                <button
                  type="button"
                  onClick={() => setLaunchRequestKey((value) => value + 1)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    minHeight: 32,
                    padding: '0 12px',
                    borderRadius: 9,
                    border: '1px solid rgba(59, 130, 246, 0.22)',
                    background: 'rgba(59, 130, 246, 0.12)',
                    color: 'var(--t-text-primary)',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <TerminalIcon size={14} />
                  Launch workspace
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );

    // Expose handleSessionCreated for parent to call
    // (handled via useImperativeHandle above for data routing)
  },
);

// TerminalTab is already exported at interface definition above
