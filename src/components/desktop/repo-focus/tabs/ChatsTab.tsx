'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from 'react';
import { ClaudeIcon, CodexIcon, GeminiIcon, OpenCodeIcon } from '@/components/desktop/repo-registry/shared';
import { CheckCircle2, ChevronDown, ChevronRight, Folder } from '../../lucide-shims';
import type { SavedChatRepoContext } from '@/lib/llm/chat-history';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { IdeWorkspaceSession, RepoFocusRepo } from '../types';
import {
  formatElapsed,
  normalizeRepoPath,
  packetBelongsToRepo,
  packetVisualState,
  repoOwnsCandidate,
  REPO_FOCUS_FONT,
} from '../utils';
import { SessionRow } from './AgentRows';

interface ChatHistoryItem {
  tabId: string;
  title: string;
  preview: string;
  empty: boolean;
  messageCount: number;
  model: string;
  savedAt: string;
  modifiedAt: string;
  starred: boolean;
  pinned: boolean;
  firstUserMessage?: string | null;
  repoName?: string | null;
  repoPath?: string | null;
  repoBranch?: string | null;
  remoteUrl?: string | null;
  archivedAt?: string | null;
}

interface ArchivedLaneRow {
  id: string;
  label: string;
  repoPath: string;
  branch: string;
  baseBranch: string;
  runtime: 'codex' | 'claude-code' | 'gemini' | 'opencode';
  sessionKey: string | null;
  updatedAt: string;
  status?: string;
}

interface ChatsTabProps {
  repos: RepoFocusRepo[];
  selectedRepo?: RepoFocusRepo | null;
  ideWorkspaceSessions?: IdeWorkspaceSession[];
  activeSessionKey?: string | null;
  onSelectSession?: (sessionKey: string) => void;
  onOpenHistoryChat?: (historyTabId: string, title: string, repo?: SavedChatRepoContext | null) => void;
  variant?: 'tab' | 'mini';
  limit?: number;
  hideWhenEmpty?: boolean;
  sectionLabel?: string | null;
  sections?: ReadonlyArray<'chat' | 'orchestrator'>;
  showLiveSessions?: boolean;
  groupMode?: 'sections' | 'flat';
  showKindInMeta?: boolean;
  packets?: OrchestratorPacket[];
}

interface HistoryActionMenuState {
  item: ChatHistoryItem;
  archived: boolean;
  x: number;
  y: number;
}

type HistoryToneKey = 'neutral' | 'activity' | 'running' | 'review' | 'merged' | 'failed' | 'active';

interface HistoryRowTone {
  key: HistoryToneKey;
  accent: string;
  background: string;
  border: string;
  iconBackground: string;
  iconColor: string;
  label?: string;
}

const HISTORY_ROW_TONES: Record<HistoryToneKey, HistoryRowTone> = {
  neutral: {
    key: 'neutral',
    accent: 'transparent',
    background: 'transparent',
    border: 'var(--t-divider-subtle)',
    iconBackground: 'transparent',
    iconColor: 'var(--t-text-muted)',
  },
  activity: {
    key: 'activity',
    accent: 'transparent',
    background: 'transparent',
    border: 'var(--t-divider-subtle)',
    iconBackground: 'transparent',
    iconColor: 'var(--t-text-muted)',
  },
  running: {
    key: 'running',
    accent: 'var(--t-accent)',
    background: 'transparent',
    border: 'var(--t-divider-subtle)',
    iconBackground: 'transparent',
    iconColor: 'var(--t-accent)',
    label: 'Running',
  },
  review: {
    key: 'review',
    accent: '#FF5A1F',
    background: 'transparent',
    border: 'var(--t-divider-subtle)',
    iconBackground: 'transparent',
    iconColor: '#FF5A1F',
    label: 'Review',
  },
  merged: {
    key: 'merged',
    accent: '#16a34a',
    background: 'transparent',
    border: 'var(--t-divider-subtle)',
    iconBackground: 'transparent',
    iconColor: '#15803d',
    label: 'Merged',
  },
  failed: {
    key: 'failed',
    accent: '#ef4444',
    background: 'transparent',
    border: 'var(--t-divider-subtle)',
    iconBackground: 'transparent',
    iconColor: '#dc2626',
    label: 'Blocked',
  },
  active: {
    key: 'active',
    accent: 'transparent',
    background: 'var(--t-input-bg)',
    border: 'var(--t-divider-subtle)',
    iconBackground: 'color-mix(in srgb, var(--t-accent) 10%, transparent)',
    iconColor: 'var(--t-accent)',
  },
};

type HistoryGroupKey = 'chat' | 'orchestrator' | 'merged' | 'archived';

interface RepoHistoryGroup {
  key: string;
  label: string;
  items: ChatHistoryItem[];
}

function shimmerTextStyle(base = 'var(--t-text)', flare = 'var(--t-accent)'): CSSProperties {
  return {
    backgroundImage: `linear-gradient(110deg, ${base} 0%, ${base} 34%, ${flare} 50%, ${base} 66%, ${base} 100%)`,
    backgroundSize: '220% 100%',
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
    WebkitTextFillColor: 'transparent',
    animation: 'o8-text-shimmer 2.35s linear infinite',
  };
}

function pathBasename(path: string | null | undefined): string {
  return normalizeRepoPath(path).split('/').filter(Boolean).pop()?.toLowerCase() ?? '';
}

function pathDisplayName(path: string | null | undefined): string {
  return normalizeRepoPath(path).split('/').filter(Boolean).pop() ?? '';
}

function historyRepoLabel(item: ChatHistoryItem): string {
  const savedName = (item.repoName ?? '').trim();
  if (savedName && savedName.toLowerCase() !== 'current project') return savedName;
  return pathDisplayName(item.repoPath) || savedName || 'project';
}

function historyRepoGroupLabel(item: ChatHistoryItem, repos: RepoFocusRepo[]): string {
  const matchedRepo = repos.find((repo) => historyBelongsToRepo(item, repo));
  return matchedRepo?.name ?? historyRepoLabel(item);
}

function normalizeRemoteUrl(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\.git$/i, '').toLowerCase();
}

function historyBelongsToRepo(item: ChatHistoryItem, repo: RepoFocusRepo): boolean {
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

function sessionBelongsToRepo(session: IdeWorkspaceSession, repo: RepoFocusRepo): boolean {
  if (repoOwnsCandidate(repo.localPath, session.workspace)) return true;
  if (repoOwnsCandidate(repo.localPath, session.runtimeSurface?.cwd)) return true;
  const workspace = session.workspace.trim().toLowerCase();
  return Boolean(workspace && (workspace === repo.name.toLowerCase() || workspace === pathBasename(repo.localPath)));
}

function historyRepoContext(item: ChatHistoryItem): SavedChatRepoContext | null {
  if (!item.repoName && !item.repoPath && !item.repoBranch && !item.remoteUrl) return null;
  return {
    name: item.repoName ?? undefined,
    localPath: item.repoPath ?? undefined,
    branch: item.repoBranch ?? undefined,
    remoteUrl: item.remoteUrl ?? undefined,
  };
}

function sessionIdentity(session: IdeWorkspaceSession): string[] {
  return [session.sessionId, session.sessionKey, session.runtimeSurface?.id]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => [value, value.replace(/^llm-chat:/, '')]);
}

function historyRuntime(item: ChatHistoryItem): 'claude-code' | 'codex' | 'gemini' | 'opencode' {
  const value = `${item.model} ${item.title}`.toLowerCase();
  if (value.includes('claude') || value.includes('opus')) return 'claude-code';
  if (value.includes('gemini')) return 'gemini';
  if (value.includes('opencode')) return 'opencode';
  return 'codex';
}

function historySection(item: ChatHistoryItem): 'orchestrator' | 'chat' {
  return item.tabId.startsWith('thoughts-') ? 'orchestrator' : 'chat';
}

function historyKindLabel(item: ChatHistoryItem): string {
  return historySection(item) === 'orchestrator' ? 'Orchestrator' : 'Chat';
}

function normalizeComparableText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[#`'"()[\]{}:;,.!?/\\|_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function packetStateTone(packet: OrchestratorPacket | null | undefined): HistoryRowTone | null {
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

function packetRepoLabel(packet: OrchestratorPacket): string {
  return pathDisplayName(packet.workspaceTargetPath) || packet.lane?.repoPath?.split('/').filter(Boolean).pop() || 'project';
}

function packetTimestamp(packet: OrchestratorPacket): string | null {
  return packet.releaseStatePayload?.releasedAt
    ?? packet.archivedAt
    ?? packet.lastEventAt
    ?? packet.lane?.lastEventAt
    ?? null;
}

function packetSortTime(packet: OrchestratorPacket): number {
  const timestamp = packetTimestamp(packet);
  const parsed = timestamp ? Date.parse(timestamp) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatElapsedAgo(timestamp: string): string {
  const elapsed = formatElapsed(timestamp);
  return elapsed === 'now' ? 'just now' : `${elapsed} ago`;
}

function packetMatchScore(item: ChatHistoryItem, packet: OrchestratorPacket): number {
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

function pickHistoryPacket(item: ChatHistoryItem, packets: OrchestratorPacket[]): OrchestratorPacket | null {
  let best: { packet: OrchestratorPacket; score: number } | null = null;
  for (const packet of packets) {
    const score = packetMatchScore(item, packet);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { packet, score };
  }
  return best?.packet ?? null;
}

function RuntimeHistoryIcon({ item, size = 12 }: { item: ChatHistoryItem; size?: number }) {
  switch (historyRuntime(item)) {
    case 'claude-code':
      return <ClaudeIcon size={size} />;
    case 'gemini':
      return <GeminiIcon size={size} />;
    case 'opencode':
      return <OpenCodeIcon size={size} />;
    default:
      return <CodexIcon size={size} />;
  }
}

export function ChatsTab({
  repos,
  selectedRepo,
  ideWorkspaceSessions = [],
  activeSessionKey,
  onSelectSession,
  onOpenHistoryChat,
  variant = 'tab',
  limit,
  hideWhenEmpty = false,
  sectionLabel = 'Chats',
  sections = ['chat', 'orchestrator'],
  showLiveSessions = true,
  groupMode = 'sections',
  packets = [],
}: ChatsTabProps) {
  const [historyItems, setHistoryItems] = useState<ChatHistoryItem[]>([]);
  const [archivedHistoryItems, setArchivedHistoryItems] = useState<ChatHistoryItem[]>([]);
  const [archivedLanes, setArchivedLanes] = useState<ArchivedLaneRow[]>([]);
  const [archivedLanesExpanded, setArchivedLanesExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [busyHistoryIds, setBusyHistoryIds] = useState<Set<string>>(() => new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Record<HistoryGroupKey, boolean>>({
    chat: false,
    orchestrator: false,
    merged: false,
    archived: true,
  });
  const [historyActionMenu, setHistoryActionMenu] = useState<HistoryActionMenuState | null>(null);

  const fetchHistory = useCallback(async (cancelled?: () => boolean) => {
    setLoading(true);
    try {
      const [activeResponse, archivedResponse] = await Promise.all([
        fetch('/api/v2/chat-history/list?include=orchestrator', { cache: 'no-store' }),
        fetch('/api/v2/chat-history/list?include=orchestrator&archived=only', { cache: 'no-store' }),
      ]);
      const activePayload = activeResponse.ok
        ? await activeResponse.json() as { conversations?: ChatHistoryItem[] }
        : { conversations: [] };
      const archivedPayload = archivedResponse.ok
        ? await archivedResponse.json() as { conversations?: ChatHistoryItem[] }
        : { conversations: [] };
      if (cancelled?.()) return;
      setHistoryItems(activePayload.conversations ?? []);
      setArchivedHistoryItems(archivedPayload.conversations ?? []);
    } catch {
      if (cancelled?.()) return;
      setHistoryItems([]);
      setArchivedHistoryItems([]);
    } finally {
      if (!cancelled?.()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchHistory(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [fetchHistory]);

  // Refetch when chat-history mutates (rename / archive / share via the
  // header title menu). Without this listener the left rail keeps the
  // pre-mutation snapshot until the next mount.
  useEffect(() => {
    const handler = () => { void fetchHistory(); };
    window.addEventListener('o8:chat-history-updated', handler as EventListener);
    return () => window.removeEventListener('o8:chat-history-updated', handler as EventListener);
  }, [fetchHistory]);

  // Archived agent sessions (Codex / lanes table) — only fetched in the
  // compact left-rail variant where they render inline under each repo.
  // The project drawer's Chats tab leaves these to its Agents tab.
  useEffect(() => {
    if (variant !== 'mini') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/lanes?active=false', { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const data = await res.json() as { lanes?: ArchivedLaneRow[] };
        const archived = (data.lanes ?? [])
          .filter((l) => l.status === 'archived')
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        if (!cancelled) setArchivedLanes(archived);
      } catch {
        // silent — best-effort
      }
    })();
    return () => { cancelled = true; };
  }, [variant]);

  const withHistoryBusy = useCallback(async (tabId: string, action: () => Promise<void>) => {
    setBusyHistoryIds((prev) => new Set(prev).add(tabId));
    try {
      await action();
      await fetchHistory();
    } finally {
      setBusyHistoryIds((prev) => {
        const next = new Set(prev);
        next.delete(tabId);
        return next;
      });
    }
  }, [fetchHistory]);

  const patchHistoryItem = useCallback(async (tabId: string, patch: Record<string, unknown>) => {
    const response = await fetch('/api/v2/chat-history', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId, ...patch }),
    });
    if (!response.ok) throw new Error('Unable to update chat history');
  }, []);

  const archiveHistoryItem = useCallback((item: ChatHistoryItem) => (
    withHistoryBusy(item.tabId, () => patchHistoryItem(item.tabId, { archivedAt: new Date().toISOString() }))
  ), [patchHistoryItem, withHistoryBusy]);

  const restoreHistoryItem = useCallback((item: ChatHistoryItem) => (
    withHistoryBusy(item.tabId, () => patchHistoryItem(item.tabId, { archivedAt: null }))
  ), [patchHistoryItem, withHistoryBusy]);

  const togglePinnedHistoryItem = useCallback((item: ChatHistoryItem) => (
    withHistoryBusy(item.tabId, () => patchHistoryItem(item.tabId, { pinned: !item.pinned, starred: !item.pinned ? true : item.starred }))
  ), [patchHistoryItem, withHistoryBusy]);

  const deleteHistoryItem = useCallback((item: ChatHistoryItem) => {
    const confirmed = window.confirm(`Delete "${item.title}" from chat history?`);
    if (!confirmed) return;
    void withHistoryBusy(item.tabId, async () => {
      const response = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(item.tabId)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Unable to delete chat history');
    });
  }, [withHistoryBusy]);

  const targetRepos = useMemo(() => (
    selectedRepo ? [selectedRepo] : repos
  ), [repos, selectedRepo]);
  const visiblePackets = useMemo(() => (
    packets.filter((packet) => targetRepos.some((repo) => packetBelongsToRepo(packet, repo.localPath)))
  ), [packets, targetRepos]);

  const visibleHistory = useMemo(() => (
    historyItems.filter((item) => targetRepos.some((repo) => historyBelongsToRepo(item, repo)))
  ), [historyItems, targetRepos]);
  const visibleArchivedHistory = useMemo(() => (
    archivedHistoryItems.filter((item) => targetRepos.some((repo) => historyBelongsToRepo(item, repo)))
  ), [archivedHistoryItems, targetRepos]);
  const allowedSections = useMemo(() => new Set(sections), [sections]);
  const visibleFlatHistory = useMemo(() => (
    visibleHistory
      .filter((item) => allowedSections.has(historySection(item)))
      .slice()
      .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
  ), [allowedSections, visibleHistory]);
  const visibleChatHistory = useMemo(() => (
    visibleHistory.filter((item) => historySection(item) === 'chat')
  ), [visibleHistory]);
  const visibleOrchestratorHistory = useMemo(() => (
    visibleHistory.filter((item) => historySection(item) === 'orchestrator')
  ), [visibleHistory]);
  const visibleMergedPackets = useMemo(() => (
    visiblePackets
      .filter((packet) => packetVisualState(packet) === 'merged')
      .slice()
      .sort((a, b) => packetSortTime(b) - packetSortTime(a))
  ), [visiblePackets]);

  const visibleHistoryIds = useMemo(() => new Set(visibleHistory.map((item) => item.tabId)), [visibleHistory]);

  const visibleSessions = useMemo(() => (
    ideWorkspaceSessions
      .filter((session) => targetRepos.some((repo) => sessionBelongsToRepo(session, repo)))
      .filter((session) => !sessionIdentity(session).some((id) => visibleHistoryIds.has(id)))
      .sort((a, b) => {
        const aTime = Number(a.lastActivityAt ?? Date.parse(a.lastEventAt));
        const bTime = Number(b.lastActivityAt ?? Date.parse(b.lastEventAt));
        return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
      })
  ), [ideWorkspaceSessions, targetRepos, visibleHistoryIds]);

  const compact = variant === 'mini';
  const shownSessions = showLiveSessions ? visibleSessions : [];
  const displayedSessions = limit ? shownSessions.slice(0, Math.min(shownSessions.length, limit)) : shownSessions;
  const remainingHistorySlots = limit ? Math.max(0, limit - displayedSessions.length) : Number.POSITIVE_INFINITY;
  const flatHistoryItems = useMemo(() => {
    if (!Number.isFinite(remainingHistorySlots)) return visibleFlatHistory;
    return visibleFlatHistory.slice(0, Math.max(0, remainingHistorySlots));
  }, [remainingHistorySlots, visibleFlatHistory]);
  const flatHistoryRepoGroups = useMemo<RepoHistoryGroup[]>(() => {
    const groups = new Map<string, RepoHistoryGroup>();
    for (const item of flatHistoryItems) {
      const label = historyRepoGroupLabel(item, targetRepos);
      const key = label.toLowerCase();
      const existing = groups.get(key);
      if (existing) {
        existing.items.push(item);
      } else {
        groups.set(key, { key, label, items: [item] });
      }
    }
    return [...groups.values()];
  }, [flatHistoryItems, targetRepos]);

  // Group archived lanes by the same repo-label key used by
  // flatHistoryRepoGroups so we can render them inline under each repo.
  const archivedLanesByRepoKey = useMemo(() => {
    const map = new Map<string, ArchivedLaneRow[]>();
    if (variant !== 'mini' || archivedLanes.length === 0) return map;
    const repoNameByPath = new Map<string, string>();
    for (const repo of targetRepos) {
      repoNameByPath.set(normalizeRepoPath(repo.localPath), repo.name);
    }
    for (const lane of archivedLanes) {
      const laneRepoPath = normalizeRepoPath(lane.repoPath);
      const repoName = repoNameByPath.get(laneRepoPath);
      if (!repoName) continue;
      const key = repoName.toLowerCase();
      const bucket = map.get(key);
      if (bucket) bucket.push(lane);
      else map.set(key, [lane]);
    }
    return map;
  }, [archivedLanes, targetRepos, variant]);

  const toggleArchivedLanes = useCallback((repoKey: string) => {
    setArchivedLanesExpanded((current) => {
      const next = new Set(current);
      if (next.has(repoKey)) next.delete(repoKey);
      else next.add(repoKey);
      return next;
    });
  }, []);
  const historyGroups = useMemo(() => {
    const sourceGroups = [
      { key: 'orchestrator' as const, label: 'Orchestrator', items: visibleOrchestratorHistory },
      { key: 'chat' as const, label: sectionLabel ?? 'Chats', items: visibleChatHistory },
    ].filter((group) => allowedSections.has(group.key));

    if (!Number.isFinite(remainingHistorySlots)) {
      return sourceGroups.filter((group) => group.items.length > 0);
    }

    const slots = Math.max(0, remainingHistorySlots);
    if (slots === 0) return [];
    if (sourceGroups.length <= 1) {
      return sourceGroups.map((group) => ({ ...group, items: group.items.slice(0, slots) })).filter((group) => group.items.length > 0);
    }

    const groups: Array<{ key: 'chat' | 'orchestrator'; label: string; items: ChatHistoryItem[] }> = [];
    let remaining = slots;
    for (const group of sourceGroups) {
      if (remaining <= 0) break;
      const reserveForLater = sourceGroups.slice(sourceGroups.indexOf(group) + 1).some((next) => next.items.length > 0) ? 1 : 0;
      const take = Math.min(group.items.length, Math.max(0, remaining - reserveForLater));
      groups.push({ ...group, items: group.items.slice(0, take) });
      remaining -= take;
    }
    return groups.filter((group) => group.items.length > 0);
  }, [allowedSections, remainingHistorySlots, sectionLabel, visibleChatHistory, visibleOrchestratorHistory]);
  const showMergedPackets = groupMode === 'sections' && !compact && visibleMergedPackets.length > 0;
  const showArchivedHistory = groupMode === 'sections' && !compact && visibleArchivedHistory.length > 0;
  const hasContent = displayedSessions.length > 0 || (
    groupMode === 'flat'
      ? flatHistoryItems.length > 0
      : historyGroups.some((group) => group.items.length > 0)
  ) || showMergedPackets || showArchivedHistory;
  const toggleGroup = (key: HistoryGroupKey) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  if (hideWhenEmpty && (!hasContent || loading)) return null;

  return (
    <div
      style={{
        minHeight: compact ? undefined : '100%',
        paddingTop: compact ? 0 : 4,
        paddingBottom: compact ? 8 : 14,
        fontFamily: REPO_FOCUS_FONT,
      }}
    >
      {displayedSessions.length > 0 ? (
        <SectionLabel label="Open now" compact={compact} />
      ) : null}
      {displayedSessions.map((session) => (
        compact ? (
          <CompactSessionRow
            key={session.sessionKey}
            session={session}
            onSelectSession={onSelectSession}
          />
        ) : (
          <SessionRow
            key={session.sessionKey}
            session={session}
            onSelectSession={onSelectSession}
          />
        )
      ))}

      {groupMode === 'flat' && flatHistoryItems.length > 0 ? (
        <div>
          {compact ? (
            flatHistoryRepoGroups.map((group) => {
              const repoArchivedLanes = archivedLanesByRepoKey.get(group.key) ?? [];
              const archivedExpanded = archivedLanesExpanded.has(group.key);
              return (
                <div key={group.key}>
                  <RepoGroupLabel label={group.label} />
                  {group.items.map((item) => (
                    <HistoryChatRow
                      key={item.tabId}
                      item={item}
                      compact={compact}
                      disabled={!onOpenHistoryChat}
                      active={activeSessionKey === item.tabId || activeSessionKey === `llm-chat:${item.tabId}`}
                      tone={packetStateTone(pickHistoryPacket(item, visiblePackets))}
                      onOpen={() => onOpenHistoryChat?.(item.tabId, item.title, historyRepoContext(item))}
                      onOpenMenu={(event) => setHistoryActionMenu({ item, archived: false, x: event.clientX, y: event.clientY })}
                    />
                  ))}
                  {repoArchivedLanes.length > 0 ? (
                    <>
                      <SectionLabel
                        label="Archived"
                        compact={compact}
                        count={repoArchivedLanes.length}
                        collapsed={!archivedExpanded}
                        onToggle={() => toggleArchivedLanes(group.key)}
                      />
                      {archivedExpanded ? repoArchivedLanes.map((lane) => (
                        <ArchivedLaneCompactRow
                          key={lane.id}
                          lane={lane}
                          onSelectSession={onSelectSession}
                        />
                      )) : null}
                    </>
                  ) : null}
                </div>
              );
            })
          ) : (
            <>
              {sectionLabel ? (
                <SectionLabel
                  label={sectionLabel}
                  compact={compact}
                />
              ) : null}
              {flatHistoryItems.map((item) => (
                <HistoryChatRow
                  key={item.tabId}
                  item={item}
                  compact={compact}
                  disabled={!onOpenHistoryChat}
                  active={activeSessionKey === item.tabId || activeSessionKey === `llm-chat:${item.tabId}`}
                  tone={packetStateTone(pickHistoryPacket(item, visiblePackets))}
                  onOpen={() => onOpenHistoryChat?.(item.tabId, item.title, historyRepoContext(item))}
                  onOpenMenu={(event) => setHistoryActionMenu({ item, archived: false, x: event.clientX, y: event.clientY })}
                />
              ))}
            </>
          )}
        </div>
      ) : null}

      {showMergedPackets ? (
        <div>
          <SectionLabel
            label="Merged"
            compact={compact}
            count={visibleMergedPackets.length}
            collapsed={collapsedGroups.merged}
            onToggle={() => toggleGroup('merged')}
          />
          {collapsedGroups.merged ? null : (
            visibleMergedPackets.slice(0, 8).map((packet) => (
              <MergedPacketRow key={packet.id} packet={packet} compact={compact} />
            ))
          )}
        </div>
      ) : null}

      {groupMode === 'sections' ? historyGroups.map((group) => (
        <div key={group.key}>
          <SectionLabel
            label={group.label}
            compact={compact}
            count={group.items.length}
            collapsed={collapsedGroups[group.key]}
            onToggle={() => toggleGroup(group.key)}
          />
          {collapsedGroups[group.key] ? null : (
            group.items.map((item) => (
              <HistoryChatRow
                key={item.tabId}
                item={item}
                compact={compact}
                disabled={!onOpenHistoryChat}
                active={activeSessionKey === item.tabId || activeSessionKey === `llm-chat:${item.tabId}`}
                tone={packetStateTone(pickHistoryPacket(item, visiblePackets))}
                onOpen={() => onOpenHistoryChat?.(item.tabId, item.title, historyRepoContext(item))}
                onOpenMenu={(event) => setHistoryActionMenu({ item, archived: false, x: event.clientX, y: event.clientY })}
              />
            ))
          )}
        </div>
      )) : null}

      {showArchivedHistory ? (
        <div>
          <SectionLabel
            label="Archived"
            compact={compact}
            count={visibleArchivedHistory.length}
            collapsed={collapsedGroups.archived}
            onToggle={() => toggleGroup('archived')}
          />
          {collapsedGroups.archived ? null : (
            visibleArchivedHistory.slice(0, 12).map((item) => (
              <HistoryChatRow
                key={item.tabId}
                item={item}
                compact={compact}
                disabled={!onOpenHistoryChat}
                active={activeSessionKey === item.tabId || activeSessionKey === `llm-chat:${item.tabId}`}
                tone={HISTORY_ROW_TONES.neutral}
                onOpen={() => onOpenHistoryChat?.(item.tabId, item.title, historyRepoContext(item))}
                onOpenMenu={(event) => setHistoryActionMenu({ item, archived: true, x: event.clientX, y: event.clientY })}
              />
            ))
          )}
        </div>
      ) : null}

      {!hasContent ? (
        <div
          style={{
            paddingTop: 42,
            paddingRight: 28,
            paddingBottom: 42,
            paddingLeft: 28,
            textAlign: 'center',
            color: 'var(--t-text-faint)',
          }}
        >
          <div style={{ fontSize: 14, lineHeight: '19px', fontWeight: 500, color: 'var(--t-text-muted)' }}>
            {loading ? 'Loading project chats…' : 'No project chats yet'}
          </div>
          <div style={{ marginTop: 4, fontSize: 12, lineHeight: '16px' }}>
            {loading ? 'Saved conversations will appear here.' : 'New and saved chats for this project will collect here.'}
          </div>
        </div>
      ) : null}
      {historyActionMenu ? (
        <HistoryActionMenu
          state={historyActionMenu}
          busy={busyHistoryIds.has(historyActionMenu.item.tabId)}
          canOpen={Boolean(onOpenHistoryChat)}
          onClose={() => setHistoryActionMenu(null)}
          onOpen={() => {
            onOpenHistoryChat?.(
              historyActionMenu.item.tabId,
              historyActionMenu.item.title,
              historyRepoContext(historyActionMenu.item),
            );
          }}
          onTogglePin={() => { void togglePinnedHistoryItem(historyActionMenu.item); }}
          onArchive={() => {
            if (historyActionMenu.archived) {
              void restoreHistoryItem(historyActionMenu.item);
            } else {
              void archiveHistoryItem(historyActionMenu.item);
            }
          }}
          onDelete={() => deleteHistoryItem(historyActionMenu.item)}
        />
      ) : null}
    </div>
  );
}

function SectionLabel({
  label,
  compact = false,
  count,
  collapsed,
  onToggle,
}: {
  label: string;
  compact?: boolean;
  count?: number;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const commonStyle = {
    paddingTop: compact ? 7 : 10,
    paddingRight: compact ? 10 : 12,
    paddingBottom: compact ? 4 : 5,
    paddingLeft: compact ? 10 : 12,
    fontSize: compact ? 9.5 : 10.5,
    lineHeight: compact ? '12px' : '14px',
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color: 'var(--t-text-faint)',
    fontFamily: REPO_FOCUS_FONT,
  };

  if (!onToggle) {
    return (
      <div style={{ ...commonStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
        {typeof count === 'number' ? (
          <span
            aria-label={`${count} ${label.toLowerCase()}`}
            style={{
              fontSize: compact ? 9 : 9.5,
              lineHeight: '12px',
              letterSpacing: 0,
              color: 'var(--t-text-faint)',
              fontWeight: 500,
            }}
          >
            {count}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      title={`${collapsed ? 'Show' : 'Hide'} ${label.toLowerCase()}`}
      style={{
        ...commonStyle,
        width: '100%',
        borderWidth: 0,
        background: 'transparent',
        cursor: 'pointer',
        outline: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        textAlign: 'left',
      }}
    >
      {collapsed ? <ChevronRight size={11} strokeWidth={2} /> : <ChevronDown size={11} strokeWidth={2} />}
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      {typeof count === 'number' ? (
        <span
          aria-label={`${count} ${label.toLowerCase()}`}
          style={{
            fontSize: compact ? 9 : 9.5,
            lineHeight: '12px',
            letterSpacing: 0,
            color: 'var(--t-text-faint)',
            fontWeight: 500,
          }}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

function RepoGroupLabel({ label }: { label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minHeight: 22,
        paddingTop: 7,
        paddingRight: 10,
        paddingBottom: 3,
        paddingLeft: 10,
        color: 'var(--t-text-secondary)',
        fontFamily: REPO_FOCUS_FONT,
      }}
    >
      <Folder size={12} strokeWidth={1.9} color="var(--t-text-faint)" />
      <span
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 11,
          lineHeight: '14px',
          fontWeight: 500,
          letterSpacing: 0,
        }}
      >
        {label}
      </span>
    </div>
  );
}

function ArchivedLaneCompactRow({
  lane,
  onSelectSession,
}: {
  lane: ArchivedLaneRow;
  onSelectSession?: (sessionKey: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const disabled = !lane.sessionKey || !onSelectSession;
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      onClick={() => {
        if (disabled || !lane.sessionKey) return;
        onSelectSession?.(lane.sessionKey);
      }}
      onKeyDown={(event) => {
        if (disabled || !lane.sessionKey) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelectSession?.(lane.sessionKey);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-disabled={disabled}
      style={{
        width: '100%',
        minHeight: 31,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        background: hovered && !disabled ? 'var(--t-hover)' : 'transparent',
        color: 'var(--t-text)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        textAlign: 'left',
        outline: 'none',
        fontFamily: REPO_FOCUS_FONT,
        paddingTop: 2,
        paddingRight: 10,
        paddingBottom: 2,
        paddingLeft: 10,
        transition: 'background 180ms ease',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 16,
          height: 16,
          borderRadius: 5,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          color: 'var(--t-text-muted)',
        }}
      >
        {lane.runtime === 'claude-code' ? (
          <ClaudeIcon size={12} />
        ) : lane.runtime === 'gemini' ? (
          <GeminiIcon size={12} />
        ) : lane.runtime === 'opencode' ? (
          <OpenCodeIcon size={12} />
        ) : (
          <CodexIcon size={12} />
        )}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 11.5,
          fontWeight: 500,
          letterSpacing: '-0.005em',
          lineHeight: 1.3,
          color: 'var(--t-text-muted)',
        }}
      >
        {lane.label}
      </span>
    </div>
  );
}

function MergedPacketRow({ packet, compact }: { packet: OrchestratorPacket; compact: boolean }) {
  const releasedAt = packetTimestamp(packet);
  const meta = releasedAt
    ? `${packetRepoLabel(packet)} · Merged · ${formatElapsedAgo(releasedAt)}`
    : `${packetRepoLabel(packet)} · Merged`;
  return (
    <div
      title={packet.title}
      style={{
        width: '100%',
        minHeight: compact ? 31 : 42,
        display: 'flex',
        alignItems: 'center',
        gap: compact ? 6 : 8,
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        background: 'transparent',
        color: 'var(--t-text)',
        textAlign: 'left',
        fontFamily: REPO_FOCUS_FONT,
        paddingTop: compact ? 2 : 5,
        paddingRight: compact ? 10 : 12,
        paddingBottom: compact ? 2 : 5,
        paddingLeft: compact ? 10 : 12,
      }}
    >
      <span
        aria-hidden
        style={{
          width: compact ? 16 : 20,
          height: compact ? 16 : 20,
          borderRadius: compact ? 5 : 6,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          color: '#16a34a',
        }}
      >
        <CheckCircle2 size={compact ? 13 : 14} strokeWidth={2.1} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: compact ? 11.25 : 12,
            lineHeight: compact ? '15px' : '16px',
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {packet.title}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 1,
            color: 'var(--t-text-faint)',
            fontSize: compact ? 9.75 : 10.25,
            lineHeight: compact ? '12px' : '13px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {meta}
        </span>
      </span>
    </div>
  );
}

function HistoryActionMenu({
  state,
  busy,
  canOpen,
  onClose,
  onOpen,
  onTogglePin,
  onArchive,
  onDelete,
}: {
  state: HistoryActionMenuState;
  busy: boolean;
  canOpen: boolean;
  onClose: () => void;
  onOpen: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const menuWidth = 190;
  const menuHeight = 180;
  const panelRect = typeof document === 'undefined'
    ? null
    : document.querySelector('[data-o8-agent-panel="true"]')?.getBoundingClientRect() ?? null;
  const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
  const boundaryLeft = panelRect?.left ?? 0;
  const boundaryRight = panelRect?.right ?? viewportWidth;
  const boundaryTop = panelRect?.top ?? 0;
  const boundaryBottom = panelRect?.bottom ?? viewportHeight;
  const minLeft = boundaryLeft + 8;
  const maxLeft = Math.max(minLeft, boundaryRight - menuWidth - 8);
  const left = Math.min(Math.max(state.x, minLeft), maxLeft);
  const minTop = boundaryTop + 8;
  const maxTop = Math.max(minTop, boundaryBottom - menuHeight - 8);
  const top = Math.min(Math.max(state.y, minTop), maxTop);

  const run = (action: () => void) => {
    onClose();
    action();
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close chat action menu"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 58,
          border: 0,
          background: 'transparent',
          cursor: 'default',
        }}
      />
      <div
        data-o8-history-action-menu="true"
        style={{
          position: 'fixed',
          left,
          top,
          zIndex: 59,
          width: menuWidth,
          borderRadius: 13,
          border: '1px solid var(--t-divider-subtle)',
          background: 'color-mix(in srgb, var(--t-bg-elevated, #ffffff) 86%, transparent)',
          boxShadow: '0 18px 48px rgba(15, 23, 42, 0.12)',
          backdropFilter: 'blur(18px) saturate(145%)',
          WebkitBackdropFilter: 'blur(18px) saturate(145%)',
          padding: 7,
          color: 'var(--t-text)',
          fontFamily: REPO_FOCUS_FONT,
        }}
      >
        <div style={{ padding: '4px 7px 7px' }}>
          <div style={{ fontSize: 11.25, lineHeight: '15px', fontWeight: 620, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {state.item.title}
          </div>
          <div style={{ marginTop: 1, color: 'var(--t-text-faint)', fontSize: 10, lineHeight: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {historyRepoLabel(state.item)} - {historyKindLabel(state.item)}
          </div>
        </div>
        <div style={{ display: 'grid', gap: 2 }}>
          <HistoryMenuRow label="Open chat" disabled={!canOpen || busy} onClick={() => run(onOpen)} />
          <HistoryMenuRow label={state.item.pinned ? 'Unpin' : 'Pin'} disabled={busy} onClick={() => run(onTogglePin)} />
          <HistoryMenuRow label={state.archived ? 'Restore' : 'Archive'} disabled={busy} onClick={() => run(onArchive)} />
          <HistoryMenuRow label="Delete" danger disabled={busy} onClick={() => run(onDelete)} />
        </div>
      </div>
    </>
  );
}

function HistoryMenuRow({
  label,
  danger = false,
  disabled = false,
  onClick,
}: {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      style={{
        width: '100%',
        minHeight: 29,
        borderRadius: 9,
        border: 0,
        background: 'transparent',
        color: disabled ? 'var(--t-text-faint)' : danger ? '#dc2626' : 'var(--t-text-muted)',
        cursor: disabled ? 'default' : 'pointer',
        textAlign: 'left',
        paddingTop: 0,
        paddingRight: 9,
        paddingBottom: 0,
        paddingLeft: 9,
        fontFamily: REPO_FOCUS_FONT,
        fontSize: 11.25,
        lineHeight: '15px',
        fontWeight: danger ? 620 : 560,
        transition: 'background 120ms ease, color 120ms ease',
      }}
      onMouseEnter={(event) => {
        if (disabled) return;
        event.currentTarget.style.background = 'var(--t-hover)';
        event.currentTarget.style.color = danger ? '#dc2626' : 'var(--t-text)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent';
        event.currentTarget.style.color = disabled ? 'var(--t-text-faint)' : danger ? '#dc2626' : 'var(--t-text-muted)';
      }}
    >
      {label}
    </button>
  );
}

function HistoryChatRow({
  item,
  active,
  disabled,
  compact,
  tone,
  onOpen,
  onOpenMenu,
}: {
  item: ChatHistoryItem;
  active: boolean;
  disabled: boolean;
  compact: boolean;
  tone?: HistoryRowTone | null;
  onOpen: () => void;
  onOpenMenu?: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const rowTone = active
    ? HISTORY_ROW_TONES.active
    : (tone ?? (historySection(item) === 'orchestrator' ? HISTORY_ROW_TONES.activity : HISTORY_ROW_TONES.neutral));
  const metaParts = compact ? [] : [
    rowTone.label ? { text: rowTone.label, status: true } : null,
    { text: formatElapsedAgo(item.modifiedAt), status: false },
  ].filter((part): part is { text: string; status: boolean } => Boolean(part?.text));
  const shimmerStatus = rowTone.key === 'running' || rowTone.key === 'review';

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      onClick={() => {
        if (!disabled) onOpen();
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onOpen();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu?.(event);
      }}
      aria-disabled={disabled}
      style={{
        width: '100%',
        minHeight: compact ? 31 : 42,
        display: 'flex',
        alignItems: 'center',
        gap: compact ? 6 : 8,
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: rowTone.border,
        background: active ? rowTone.background : hovered ? 'var(--t-hover)' : rowTone.background,
        color: 'var(--t-text)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.72 : 1,
        textAlign: 'left',
        outline: 'none',
        fontFamily: REPO_FOCUS_FONT,
        paddingTop: compact ? 2 : 5,
        paddingRight: compact ? 10 : 12,
        paddingBottom: compact ? 2 : 5,
        paddingLeft: compact ? 10 : 12,
        transition: 'background 180ms ease, opacity 180ms ease',
      }}
    >
      <span
        aria-hidden
        style={{
          width: compact ? 16 : 20,
          height: compact ? 16 : 20,
          borderRadius: compact ? 5 : 6,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          background: rowTone.iconBackground,
          color: rowTone.iconColor,
        }}
      >
        <RuntimeHistoryIcon item={item} size={compact ? 11 : 14} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          className={active ? 'o8-text-shimmer' : undefined}
          style={{
            display: 'block',
            fontSize: compact ? 10.75 : 12,
            lineHeight: compact ? '13px' : '16px',
            fontWeight: 400,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            ...(active ? shimmerTextStyle('var(--t-text)', 'var(--t-accent)') : {}),
          }}
        >
          {item.title}
        </span>
        {metaParts.length > 0 ? (
          <span
            style={{
              display: 'block',
              marginTop: 1,
              color: 'var(--t-text-faint)',
              fontSize: compact ? 9.75 : 10.25,
              lineHeight: compact ? '12px' : '13px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {metaParts.map((part, index) => (
              <span key={`${part.text}-${index}`}>
                {index > 0 ? <span>{' · '}</span> : null}
                <span
                  className={part.status && shimmerStatus ? 'o8-text-shimmer' : undefined}
                  style={part.status ? {
                    color: rowTone.iconColor,
                    fontWeight: 650,
                    ...(shimmerStatus ? shimmerTextStyle(rowTone.iconColor, 'var(--t-text)') : {}),
                  } : undefined}
                >
                  {part.text}
                </span>
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function CompactSessionRow({
  session,
  onSelectSession,
}: {
  session: IdeWorkspaceSession;
  onSelectSession?: (sessionKey: string) => void;
}) {
  const runtimeItem: ChatHistoryItem = {
    tabId: session.sessionKey,
    title: session.name,
    preview: '',
    empty: false,
    messageCount: 0,
    model: session.runtime,
    savedAt: session.lastEventAt,
    modifiedAt: session.lastEventAt,
    starred: false,
    pinned: false,
    repoName: null,
    repoPath: session.workspace,
    repoBranch: session.branch,
    remoteUrl: null,
  };
  return (
    <button
      type="button"
      onClick={() => onSelectSession?.(session.sessionKey)}
      style={{
        width: '100%',
        minHeight: 36,
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        borderWidth: 0,
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        background: 'transparent',
        color: 'var(--t-text)',
        cursor: 'pointer',
        textAlign: 'left',
        outline: 'none',
        fontFamily: REPO_FOCUS_FONT,
        paddingTop: 4,
        paddingRight: 10,
        paddingBottom: 4,
        paddingLeft: 10,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 18,
          height: 18,
          borderRadius: 6,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          color: 'var(--t-text-muted)',
        }}
      >
        <RuntimeHistoryIcon item={runtimeItem} size={13} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 11.25, lineHeight: '15px', fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {session.name || session.runtime || 'Agent'}
        </span>
        <span style={{ display: 'block', marginTop: 1, color: 'var(--t-text-faint)', fontSize: 9.75, lineHeight: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {session.branch || 'workspace'} · {formatElapsed(session.lastActivityAt ?? session.lastEventAt)} idle
        </span>
      </span>
    </button>
  );
}
