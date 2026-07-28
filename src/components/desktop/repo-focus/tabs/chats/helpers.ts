import type { CSSProperties } from 'react';
import type { SavedChatRepoContext } from '@/lib/llm/chat-history';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { IdeWorkspaceSession, RepoFocusRepo } from '../../types';
import {
  formatElapsed,
  normalizeRepoPath,
  packetBelongsToRepo,
  packetVisualState,
  repoOwnsCandidate,
} from '../../utils';
import { HISTORY_ROW_TONES } from './constants';
import type { ChatHistoryItem, HistoryRowTone } from './types';

export function resolveRailActiveSessionKey(
  activeSessionKey: string | null | undefined,
  focusedTab?: { kind: string; orchestratorThreadId?: string | null } | null,
): string | null {
  if (focusedTab?.kind !== 'orchestrator') return activeSessionKey ?? null;
  const threadId = focusedTab.orchestratorThreadId?.trim();
  return threadId ? `llm-chat:${threadId}` : null;
}

/**
 * Active-row text cue — solid ink on a slow opacity pulse. The earlier form
 * swept a flare gradient through a background-clip:text fill, which made
 * WebKit re-rasterize the glyphs every frame for as long as the row stayed
 * active. Duplicate of control-room/helpers.ts shimmerTextStyle — change both
 * together.
 */
export function shimmerTextStyle(base = 'var(--t-text)'): CSSProperties {
  return {
    color: base,
    animation: 'o8-text-shimmer 2.35s ease-in-out infinite',
  };
}

export function pathBasename(path: string | null | undefined): string {
  return normalizeRepoPath(path).split('/').filter(Boolean).pop()?.toLowerCase() ?? '';
}

export function pathDisplayName(path: string | null | undefined): string {
  return normalizeRepoPath(path).split('/').filter(Boolean).pop() ?? '';
}

export function historyRepoLabel(item: ChatHistoryItem): string {
  const savedName = (item.repoName ?? '').trim();
  if (savedName && savedName.toLowerCase() !== 'current project') return savedName;
  return pathDisplayName(item.repoPath) || savedName || 'project';
}

/**
 * Sentinel returned by historyRepoGroupLabel when a chat has no
 * recognized repo association (item.repoPath is empty AND nothing in
 * the registry matches). ChatsTab renders these under a "Conversations"
 * section at the bottom, separate from the project-grouped chats —
 * Antigravity-style.
 */
export const CONVERSATIONS_GROUP_KEY = '__conversations__';

export function historyRepoGroupLabel(item: ChatHistoryItem, repos: RepoFocusRepo[]): string {
  const matchedRepo = repos.find((repo) => historyBelongsToRepo(item, repo));
  if (matchedRepo) return matchedRepo.name;
  const repoPath = (item.repoPath ?? '').trim();
  const repoName = (item.repoName ?? '').trim();
  // No registered repo match AND no explicit repoPath/repoName ⇒
  // free-floating chat. Drop it into the Conversations bucket.
  if (!repoPath && !repoName) return CONVERSATIONS_GROUP_KEY;
  return historyRepoLabel(item);
}

export function normalizeRemoteUrl(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\.git$/i, '').toLowerCase();
}

export function historyBelongsToRepo(item: ChatHistoryItem, repo: RepoFocusRepo): boolean {
  if (repoOwnsCandidate(repo.localPath, item.repoPath)) return true;
  const repoName = repo.name.toLowerCase();
  const repoBase = pathBasename(repo.localPath);
  const historyRepoName = (item.repoName ?? '').trim().toLowerCase();
  if (historyRepoName && (historyRepoName === repoName || historyRepoName === repoBase)) return true;
  const historyBase = pathBasename(item.repoPath);
  if (historyBase && (historyBase === repoName || historyBase === repoBase)) return true;
  const historyRemote = normalizeRemoteUrl(item.remoteUrl);
  const repoRemote = normalizeRemoteUrl(repo.remoteUrl);
  return Boolean(historyRemote && repoRemote && historyRemote === repoRemote);
}

/** A worker may nest under its spawning thread only when both belong to the
 * same repo. Missions can explicitly dispatch into another repo; nesting those
 * packets under the orchestrator's repo hides their real rail group. */
export function packetCanNestUnderHistory(
  item: ChatHistoryItem,
  packet: OrchestratorPacket,
  repos: RepoFocusRepo[],
): boolean {
  const matchedHistoryRepo = repos.find((repo) => historyBelongsToRepo(item, repo));
  if (matchedHistoryRepo) return packetBelongsToRepo(packet, matchedHistoryRepo.localPath);
  const historyPath = normalizeRepoPath(item.repoPath);
  return Boolean(historyPath && packetBelongsToRepo(packet, historyPath));
}

export function deriveNestedPacketIds(
  items: ChatHistoryItem[],
  packetsByThread: ReadonlyMap<string, readonly OrchestratorPacket[]>,
  repos: RepoFocusRepo[],
  enabled: boolean,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!enabled) return ids;
  for (const item of items) {
    const owned = packetsByThread.get(item.tabId);
    if (!owned) continue;
    for (const packet of owned) {
      if (packetCanNestUnderHistory(item, packet, repos)) ids.add(packet.id);
    }
  }
  return ids;
}

export function sessionBelongsToRepo(session: IdeWorkspaceSession, repo: RepoFocusRepo): boolean {
  if (repoOwnsCandidate(repo.localPath, session.workspace)) return true;
  if (repoOwnsCandidate(repo.localPath, session.runtimeSurface?.cwd)) return true;
  const workspace = session.workspace.trim().toLowerCase();
  return Boolean(workspace && (workspace === repo.name.toLowerCase() || workspace === pathBasename(repo.localPath)));
}

export function isAutomationSession(session: IdeWorkspaceSession): boolean {
  return session.sessionKind === 'automation'
    || session.runtimeSurface?.sourceLabel === 'Automation run'
    || session.squadId === 'automation';
}

export function historyRepoContext(item: ChatHistoryItem): SavedChatRepoContext | null {
  if (!item.repoName && !item.repoPath && !item.repoBranch && !item.remoteUrl) return null;
  return {
    name: item.repoName ?? undefined,
    localPath: item.repoPath ?? undefined,
    branch: item.repoBranch ?? undefined,
    remoteUrl: item.remoteUrl ?? undefined,
  };
}

export function sessionIdentity(session: IdeWorkspaceSession): string[] {
  return [session.sessionId, session.sessionKey, session.runtimeSurface?.id]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => [value, value.replace(/^llm-chat:/, '')]);
}

export function historyRuntime(item: ChatHistoryItem): 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'cursor' | 'grok' {
  const value = `${item.model} ${item.title}`.toLowerCase();
  if (value.includes('claude') || value.includes('opus')) return 'claude-code';
  if (value.includes('gemini')) return 'gemini';
  if (value.includes('opencode')) return 'opencode';
  if (value.includes('cursor')) return 'cursor';
  if (value.includes('grok')) return 'grok';
  return 'codex';
}

export function historySection(item: ChatHistoryItem): 'orchestrator' | 'chat' {
  return item.tabId.startsWith('thoughts-') ? 'orchestrator' : 'chat';
}

export function historyKindLabel(item: ChatHistoryItem): string {
  return historySection(item) === 'orchestrator' ? 'Orchestrator' : 'Chat';
}

export function normalizeComparableText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[#`'"()[\]{}:;,.!?/\\|_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function packetStateTone(packet: OrchestratorPacket | null | undefined): HistoryRowTone | null {
  if (!packet) return null;
  switch (packetVisualState(packet)) {
    case 'merged':
      return HISTORY_ROW_TONES.merged;
    case 'failed':
      return HISTORY_ROW_TONES.failed;
    case 'awaiting_review':
      return HISTORY_ROW_TONES.review;
    case 'running':
      return HISTORY_ROW_TONES.running;
    default:
      return null;
  }
}

export function packetRepoLabel(packet: OrchestratorPacket): string {
  return pathDisplayName(packet.workspaceTargetPath) || packet.lane?.repoPath?.split('/').filter(Boolean).pop() || 'project';
}

export function packetTimestamp(packet: OrchestratorPacket): string | null {
  return packet.releaseStatePayload?.releasedAt
    ?? packet.archivedAt
    ?? packet.lastEventAt
    ?? packet.lane?.lastEventAt
    ?? null;
}

export function packetSortTime(packet: OrchestratorPacket): number {
  const timestamp = packetTimestamp(packet);
  const parsed = timestamp ? Date.parse(timestamp) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatElapsedAgo(timestamp: string): string {
  const elapsed = formatElapsed(timestamp);
  return elapsed === 'now' ? 'just now' : `${elapsed} ago`;
}

export function packetMatchScore(item: ChatHistoryItem, packet: OrchestratorPacket): number {
  const itemIds = new Set([item.tabId, `llm-chat:${item.tabId}`, `codex:${item.tabId}`]);
  if (packet.lane?.sessionKey && itemIds.has(packet.lane.sessionKey)) return 100;
  if (packet.lane?.tabId && itemIds.has(packet.lane.tabId)) return 98;

  const itemRepo = normalizeRepoPath(item.repoPath);
  if (itemRepo && !packetBelongsToRepo(packet, itemRepo)) return 0;

  const title = normalizeComparableText(item.title);
  const firstUserMessage = normalizeComparableText(item.firstUserMessage);
  const packetTitle = normalizeComparableText(packet.title);
  if (packetTitle.length < 12) return 0;
  if (title.length >= 12 && (packetTitle.includes(title) || title.includes(packetTitle))) return 80;
  if (firstUserMessage.length >= 20 && (firstUserMessage.includes(packetTitle) || packetTitle.includes(firstUserMessage.slice(0, 80)))) return 72;
  if (title.length < 12) return 0;

  const titleLead = title.slice(0, 42);
  const packetLead = packetTitle.slice(0, 42);
  if (titleLead.length >= 20 && packetTitle.includes(titleLead)) return 64;
  if (packetLead.length >= 20 && title.includes(packetLead)) return 58;

  return 0;
}

export function pickHistoryPacket(item: ChatHistoryItem, packets: OrchestratorPacket[]): OrchestratorPacket | null {
  let best: { packet: OrchestratorPacket; score: number } | null = null;
  for (const packet of packets) {
    const score = packetMatchScore(item, packet);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { packet, score };
  }
  return best?.packet ?? null;
}
