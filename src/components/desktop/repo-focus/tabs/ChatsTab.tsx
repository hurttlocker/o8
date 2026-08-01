'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { orchestratorBackendDisplayLabel } from '@/lib/orchestrator/display';
import { OrchestratorHoverCard } from '@/components/desktop/OrchestratorHoverCard';
import { requestConfirm, toast } from '@/components/shared/ConfirmToastHost';
import { clearLastOrchestratorThreadForId } from '@/components/desktop/workspace-terminal/orchestrator-thread-restore';
import { canCreateOrchestratorForRepo } from '../../agent-panel-repo-selection';
import {
  packetBelongsToRepo,
  packetVisualState,
  REPO_FOCUS_FONT,
} from '../utils';
import { SessionRow } from './AgentRows';
import { ChatGroupPicker, type ChatGroupMode } from './chats/ChatGroupPicker';
import { MissingRepoRailNotice } from './chats/MissingRepoRailNotice';
import { HISTORY_ROW_TONES } from './chats/constants';
import {
  CONVERSATIONS_GROUP_KEY,
  historyBelongsToRepo,
  historyRepoContext,
  historySection,
  isAutomationSession,
  packetSortTime,
  packetStateTone,
  packetTimestamp,
  pickHistoryPacket,
  sessionBelongsToRepo,
  sessionIdentity,
} from './chats/helpers';
import {
  ArchivedLaneCompactRow,
  HistoryChatRow,
  MergedPacketRow,
} from './chats/HistoryRows';
import { HistoryActionMenu } from './chats/Menus';
import { RepoGroupLabel, SectionLabel } from './chats/shared';
import {
  deriveArchivedLanes,
  deriveHistoryDateGroups,
  deriveHistoryRepoGroups,
  derivePrioritySplit,
  deriveShowRepoSuffix,
  deriveSweptThreads,
  isCompletionUnread,
  repoSuffix,
  SIDEBAR_HOVER_THREAD_EVENT,
} from './chats/sections';
import { getLastVisited, markVisited } from './chats/read-state';
import type {
  ArchivedLaneRow,
  ChatHistoryItem,
  ChatsTabProps,
  HistoryActionMenuState,
  HistoryGroupKey,
} from './chats/types';

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
  agentsSection,
  onCreateOrchestratorForRepo,
}: ChatsTabProps) {
  const [historyItems, setHistoryItems] = useState<ChatHistoryItem[]>([]);
  const [archivedHistoryItems, setArchivedHistoryItems] = useState<ChatHistoryItem[]>([]);
  const [archivedLanes, setArchivedLanes] = useState<ArchivedLaneRow[]>([]);
  const [showAllChats, setShowAllChats] = useState(false);

  // Group-by mode for the left-rail chat list (mini / flat variant).
  // Three modes, persisted to localStorage. Borrowed from Claude's
  // sidebar pattern in the operator's reference video — the filter
  // icon on a group header opens a Group by / Sort by popover.
  const CHAT_GROUP_BY_KEY = 'o8:chat-group-by';
  const [chatGroupBy, setChatGroupBy] = useState<ChatGroupMode>('flat');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(CHAT_GROUP_BY_KEY);
    if (stored === 'repo' || stored === 'date' || stored === 'flat' || stored === 'activity') {
      setChatGroupBy(stored);
    }
  }, []);
  const updateChatGroupBy = useCallback((next: ChatGroupMode) => {
    setChatGroupBy(next);
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(CHAT_GROUP_BY_KEY, next); } catch { /* ignore */ }
    }
  }, []);
  // Per-repo drawer collapse (repo grouping only) — each repo header is a
  // minimizable drawer, Cursor-style. Persisted as a JSON array of
  // collapsed group keys so the drawer state survives reloads.
  const REPO_COLLAPSED_KEY = 'o8:chat-repo-groups-collapsed';
  const [collapsedRepoGroups, setCollapsedRepoGroups] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(REPO_COLLAPSED_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as unknown;
      if (Array.isArray(parsed)) {
        setCollapsedRepoGroups(new Set(parsed.filter((key): key is string => typeof key === 'string')));
      }
    } catch { /* ignore */ }
  }, []);
  const toggleRepoGroup = useCallback((key: string) => {
    setCollapsedRepoGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      if (typeof window !== 'undefined') {
        try { window.localStorage.setItem(REPO_COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      }
      return next;
    });
  }, []);
  const [loading, setLoading] = useState(true);
  const [busyHistoryIds, setBusyHistoryIds] = useState<Set<string>>(() => new Set());
  // Rail recency = the last time the conversation SPOKE (Q ruling
  // 2026-07-16). The previous ChatGPT-style click-bump (an optimistic
  // clickedAt map that overrode modifiedAt so an opened chat popped to the
  // top) is deliberately GONE — clicking a chat must not reorder the rail;
  // only a new message does. modifiedAt itself is last-message-derived
  // server-side (chat-history/list + the mobile lister) for the same reason.
  const effectiveModifiedAtMs = useCallback((item: ChatHistoryItem) => {
    const ts = Date.parse(item.modifiedAt);
    return Number.isFinite(ts) ? ts : 0;
  }, []);
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
      const response = await fetch('/api/v2/chat-history/list?include=orchestrator&archived=include', { cache: 'no-store' });
      const payload = response.ok
        ? await response.json() as { conversations?: ChatHistoryItem[] }
        : { conversations: [] };
      if (cancelled?.()) return;
      const conversations = payload.conversations ?? [];
      setHistoryItems(conversations.filter((item) => !item.archivedAt));
      setArchivedHistoryItems(conversations.filter((item) => Boolean(item.archivedAt)));
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

  useEffect(() => {
    const activeThreadId = (activeSessionKey ?? '').replace(/^llm-chat:/, '');
    if (!historyItems.some((item) => item.tabId === activeThreadId)) return;
    markVisited(`thread:${activeThreadId}`);
  }, [activeSessionKey, historyItems]);

  const openHistoryItem = useCallback((item: ChatHistoryItem) => {
    markVisited(`thread:${item.tabId}`);
    onOpenHistoryChat?.(item.tabId, item.title, historyRepoContext(item));
  }, [onOpenHistoryChat]);

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

  const renameHistoryItem = useCallback((item: ChatHistoryItem, title: string) => (
    withHistoryBusy(item.tabId, () => patchHistoryItem(item.tabId, { title }))
  ), [patchHistoryItem, withHistoryBusy]);

  const deleteHistoryItem = useCallback((item: ChatHistoryItem) => {
    void (async () => {
      const confirmed = await requestConfirm({
        title: `Delete "${item.title}" from chat history?`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!confirmed) return;
      try {
        await withHistoryBusy(item.tabId, async () => {
          const response = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(item.tabId)}`, { method: 'DELETE' });
          if (!response.ok) {
            // Parse the API error message so we can surface it to the operator
            // (file lock, permission, ENOENT race — server now logs + 500s
            // instead of silently 200-OK'ing failed unlinks).
            const payload = await response.json().catch(() => null) as { error?: string } | null;
            throw new Error(payload?.error ?? `Delete failed (${response.status})`);
          }
        });
        // Notify any open workspace tab bound to this thread so it resets to the
        // fresh new-chat state instead of showing the dead transcript — the row
        // dropped from this rail, but the center tab had no signal until now
        // (operator reports v0.1.557/560/580).
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('o8:chat-history-deleted', { detail: { tabId: item.tabId } }));
          // And clear the last-active restore keys — in any repo bucket — that
          // point at the deleted thread, so a reload can't resurrect it into a
          // workspace tab.
          clearLastOrchestratorThreadForId(item.tabId);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Delete failed';
        toast(`Couldn't delete "${item.title}": ${message}. Try again — if Codex was busy on this thread the file may have been locked.`);
      }
    })();
  }, [withHistoryBusy]);

  const targetRepos = useMemo(() => (
    selectedRepo ? [selectedRepo] : repos
  ), [repos, selectedRepo]);
  const repoByGroupKey = useMemo(() => {
    const map = new Map<string, (typeof targetRepos)[number]>();
    for (const repo of targetRepos) map.set(repo.name.toLowerCase(), repo);
    return map;
  }, [targetRepos]);
  const visiblePackets = useMemo(() => (
    packets.filter((packet) => targetRepos.some((repo) => packetBelongsToRepo(packet, repo.localPath)))
  ), [packets, targetRepos]);

  const visibleHistory = useMemo(() => (
    historyItems.filter((item) => targetRepos.some((repo) => historyBelongsToRepo(item, repo)))
  ), [historyItems, targetRepos]);
  const historyPacketsByTabId = useMemo(() => new Map(
    visibleHistory.map((item) => [item.tabId, pickHistoryPacket(item, visiblePackets)]),
  ), [visibleHistory, visiblePackets]);
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
  const livePacketThreadIds = useMemo(() => new Set(visiblePackets
    .filter((packet) => packetVisualState(packet) !== 'merged' && packet.status !== 'archived')
    .map((packet) => packet.orchestratorThreadId?.trim())
    .filter((threadId): threadId is string => Boolean(threadId))), [visiblePackets]);
  const sweptThreads = useMemo(() => deriveSweptThreads(visibleFlatHistory, {
    activeSessionKey,
    liveThreadIds: livePacketThreadIds,
  }), [activeSessionKey, livePacketThreadIds, visibleFlatHistory]);
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

  // Worker packets keyed by the orchestrator thread that spawned them
  // (packet.orchestratorThreadId === thread tabId, taught on create_mission).
  // Archived packets stay out — they live in the Archived section.
  const ownedPacketsByThread = useMemo(() => {
    const map = new Map<string, typeof visiblePackets>();
    for (const packet of visiblePackets) {
      const threadId = packet.orchestratorThreadId?.trim();
      if (!threadId || packet.status === 'archived') continue;
      const bucket = map.get(threadId);
      if (bucket) bucket.push(packet);
      else map.set(threadId, [packet]);
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => packetSortTime(b) - packetSortTime(a));
    }
    return map;
  }, [visiblePackets]);

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
  const shownSessions = showLiveSessions ? visibleSessions : visibleSessions.filter(isAutomationSession);
  const displayedSessions = limit ? shownSessions.slice(0, Math.min(shownSessions.length, limit)) : shownSessions;
  const remainingHistorySlots = limit ? Math.max(0, limit - displayedSessions.length) : Number.POSITIVE_INFINITY;
  const sortedChatItems = useMemo(() => (
    [...sweptThreads.chats].sort((a, b) => (
      effectiveModifiedAtMs(b) - effectiveModifiedAtMs(a)
    ))
  ), [effectiveModifiedAtMs, sweptThreads.chats]);
  const chatCap = compact && !showAllChats ? 12 : Number.POSITIVE_INFINITY;
  const historyCap = Number.isFinite(remainingHistorySlots) ? remainingHistorySlots : Number.POSITIVE_INFINITY;
  const flatHistoryItems = sortedChatItems.slice(0, Math.max(0, Math.min(chatCap, historyCap)));
  const cappedChatCount = Math.min(sortedChatItems.length, historyCap);
  const flatHistoryRepoGroups = useMemo(
    () => deriveHistoryRepoGroups(flatHistoryItems, targetRepos),
    [flatHistoryItems, targetRepos],
  );
  const flatHistoryDateGroups = useMemo(
    () => deriveHistoryDateGroups(flatHistoryItems),
    [flatHistoryItems],
  );
  const activitySplit = useMemo(() => {
    const eligibleItems = sortedChatItems.slice(0, historyCap);
    const split = derivePrioritySplit(eligibleItems.map((item) => {
      const packet = historyPacketsByTabId.get(item.tabId);
      return {
        item,
        modifiedAt: item.modifiedAt,
        status: packet?.status ?? null,
        rejected: packet?.review?.approved === false,
        outcome: packet?.releaseState === 'released' ? 'merged' : null,
        unread: packet
          ? isCompletionUnread(packetTimestamp(packet), getLastVisited(`packet:${packet.id}`))
          : false,
      };
    }));
    return {
      priority: split.priority.map((entry) => entry.item),
      remainder: split.remainder.map((entry) => entry.item),
    };
  }, [historyCap, historyPacketsByTabId, sortedChatItems]);
  const activityDateItems = activitySplit.remainder.slice(
    0,
    compact && !showAllChats ? Math.max(0, 12 - activitySplit.priority.length) : Number.POSITIVE_INFINITY,
  );
  const activityDateGroups = useMemo(
    () => deriveHistoryDateGroups(activityDateItems),
    [activityDateItems],
  );
  const shownActivityCount = activitySplit.priority.length + activityDateItems.length;
  const hiddenChatCount = Math.max(0, cappedChatCount - (
    chatGroupBy === 'activity' ? shownActivityCount : flatHistoryItems.length
  ));
  const showRepoSuffix = deriveShowRepoSuffix([...visibleHistory, ...visibleArchivedHistory]);

  const flatArchivedLanes = useMemo(
    () => deriveArchivedLanes(archivedLanes, targetRepos.map((repo) => repo.localPath)),
    [archivedLanes, targetRepos],
  );
  const combinedArchivedHistory = useMemo(() => {
    const byId = new Map<string, ChatHistoryItem>();
    for (const item of [...visibleArchivedHistory, ...sweptThreads.swept]) {
      if (allowedSections.has(historySection(item))) byId.set(item.tabId, item);
    }
    return [...byId.values()].sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  }, [allowedSections, sweptThreads.swept, visibleArchivedHistory]);
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
  const showArchivedHistory = combinedArchivedHistory.length > 0 || flatArchivedLanes.length > 0;
  const hasContent = displayedSessions.length > 0 || (
    groupMode === 'flat'
      ? flatHistoryItems.length > 0
      : historyGroups.some((group) => group.items.length > 0)
  ) || Boolean(agentsSection) || showMergedPackets || showArchivedHistory;
  const toggleGroup = (key: HistoryGroupKey) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Fleet reveal: hovering a thread that owns live packets lights those rows
  // in the Agents section (SIDEBAR_HOVER_THREAD_EVENT) immediately, and opens
  // the orchestrator hover card on dwell. The card's own hover keeps both
  // alive so the pointer can travel onto it.
  const [threadHover, setThreadHover] = useState<{ item: ChatHistoryItem; rect: DOMRect } | null>(null);
  const threadHoverOpenRef = useRef<number | null>(null);
  const threadHoverCloseRef = useRef<number | null>(null);
  const broadcastThreadLink = useCallback((packetIds: string[] | null) => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(SIDEBAR_HOVER_THREAD_EVENT, { detail: { packetIds } }));
  }, []);
  const clearThreadHoverTimers = useCallback(() => {
    if (threadHoverOpenRef.current) window.clearTimeout(threadHoverOpenRef.current);
    if (threadHoverCloseRef.current) window.clearTimeout(threadHoverCloseRef.current);
    threadHoverOpenRef.current = null;
    threadHoverCloseRef.current = null;
  }, []);
  const handleThreadHover = useCallback((item: ChatHistoryItem, packetIds: string[], rect: DOMRect | null) => {
    clearThreadHoverTimers();
    if (rect) {
      broadcastThreadLink(packetIds);
      threadHoverOpenRef.current = window.setTimeout(() => setThreadHover({ item, rect }), 240);
    } else {
      broadcastThreadLink(null);
      threadHoverCloseRef.current = window.setTimeout(() => setThreadHover(null), 160);
    }
  }, [broadcastThreadLink, clearThreadHoverTimers]);
  useEffect(() => () => {
    // Never leave the Agents section stuck dimmed if this tab unmounts mid-hover.
    clearThreadHoverTimers();
    broadcastThreadLink(null);
  }, [broadcastThreadLink, clearThreadHoverTimers]);

  const renderHistoryRow = (item: ChatHistoryItem, archived = false) => {
    const owned = archived ? [] : ownedPacketsByThread.get(item.tabId) ?? [];
    const packet = historyPacketsByTabId.get(item.tabId);
    const worktreeBacked = Boolean(packet?.lane || item.repoPath?.includes('/.cortex-worktrees/'));
    return (
      <HistoryChatRow
        key={item.tabId}
        item={item}
        compact={compact}
        disabled={!onOpenHistoryChat}
        active={activeSessionKey === item.tabId || activeSessionKey === `llm-chat:${item.tabId}`}
        tone={archived ? HISTORY_ROW_TONES.neutral : packetStateTone(packet)}
        repoLabel={repoSuffix(item) ?? (!showRepoSuffix && targetRepos.length === 1 ? targetRepos[0]?.name : null)}
        branchLabel={worktreeBacked ? item.repoBranch ?? packet?.branchTarget ?? null : null}
        ownedCount={owned.length}
        onHoverChange={owned.length > 0
          ? (rect) => handleThreadHover(item, owned.map((packet) => packet.id), rect)
          : undefined}
        onOpen={() => openHistoryItem(item)}
        onOpenMenu={(event) => setHistoryActionMenu({ item, archived, x: event.clientX, y: event.clientY })}
      />
    );
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
      {/* Top-level live sessions block — hidden in compact (AgentPanel)
          mode because automation sessions already render under the
          Spawned agents → <repo> group below. Showing them here too
          caused a visible Daily standup duplication at the top of the
          panel. Non-compact callers (full repo focus view) still get
          the active-session header for context. */}
      {!compact ? (
        displayedSessions.map((session) => (
          <SessionRow
            key={session.sessionKey}
            session={session}
            onSelectSession={onSelectSession}
          />
        ))
      ) : null}

      {groupMode === 'flat' && (flatHistoryItems.length > 0 || (compact && chatGroupBy === 'activity')) ? (
        <div>
          {compact ? (
            <>
              <SectionLabel label="Chats" compact />
              {chatGroupBy === 'activity' ? (
                <>
                  <RepoGroupLabel
                    label="Priority"
                    noIcon
                    trailing={<ChatGroupPicker mode={chatGroupBy} onChange={updateChatGroupBy} />}
                  />
                  {activitySplit.priority.length > 0 ? (
                    activitySplit.priority.map((item) => renderHistoryRow(item))
                  ) : (
                    <div
                      style={{
                        paddingTop: 2,
                        paddingRight: 12,
                        paddingBottom: 5,
                        paddingLeft: 29,
                        color: 'var(--t-text-faint)',
                        fontSize: 9.5,
                        lineHeight: 1.25,
                        fontWeight: 260,
                        letterSpacing: '-0.4px',
                      }}
                    >
                      Nothing needs attention
                    </div>
                  )}
                  {activityDateGroups.map((group) => (
                    <div key={group.key}>
                      <RepoGroupLabel label={group.label} noIcon />
                      {group.items.map((item) => renderHistoryRow(item))}
                    </div>
                  ))}
                </>
              ) : chatGroupBy === 'flat' ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 0, paddingRight: 10, paddingBottom: 2 }}>
                    <ChatGroupPicker mode={chatGroupBy} onChange={updateChatGroupBy} />
                  </div>
                  {flatHistoryItems.map((item) => renderHistoryRow(item))}
                </>
              ) : chatGroupBy === 'date' ? (
                flatHistoryDateGroups.map((group, index) => (
                  <div key={group.key}>
                    <RepoGroupLabel
                      label={group.label}
                      trailing={index === 0 ? <ChatGroupPicker mode={chatGroupBy} onChange={updateChatGroupBy} /> : null}
                    />
                    {group.items.map((item) => renderHistoryRow(item))}
                  </div>
                ))
              ) : (
                flatHistoryRepoGroups.map((group, index) => {
                  const isConversations = group.key === CONVERSATIONS_GROUP_KEY;
                  const groupCollapsed = collapsedRepoGroups.has(group.key);
                  const groupRepo = isConversations ? undefined : repoByGroupKey.get(group.key);
                  const groupRepoMissing = groupRepo?.readiness?.state === 'missing';
                  return (
                    <div key={group.key}>
                      <RepoGroupLabel
                        label={group.label}
                        noIcon={isConversations}
                        collapsed={groupCollapsed}
                        onToggle={() => toggleRepoGroup(group.key)}
                        onCreate={canCreateOrchestratorForRepo(groupRepo) && onCreateOrchestratorForRepo
                          ? () => onCreateOrchestratorForRepo(groupRepo)
                          : undefined}
                        createTitle={groupRepo ? `New session in ${groupRepo.name}` : undefined}
                        trailing={index === 0 ? <ChatGroupPicker mode={chatGroupBy} onChange={updateChatGroupBy} /> : null}
                      />
                      {groupRepoMissing ? <MissingRepoRailNotice summary={groupRepo.readiness?.summary ?? ''} /> : null}
                      {groupCollapsed ? null : group.items.map((item) => renderHistoryRow(item))}
                    </div>
                  );
                })
              )}
              {hiddenChatCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowAllChats(true)}
                  style={{
                    width: '100%',
                    minHeight: 25,
                    borderWidth: 0,
                    background: 'transparent',
                    color: 'var(--t-text-faint)',
                    cursor: 'pointer',
                    paddingTop: 4,
                    paddingRight: 12,
                    paddingBottom: 4,
                    paddingLeft: 37,
                    textAlign: 'left',
                    fontFamily: REPO_FOCUS_FONT,
                    fontSize: 9.5,
                    fontWeight: 260,
                    letterSpacing: '-0.4px',
                  }}
                >
                  Show {hiddenChatCount} more
                </button>
              ) : null}
            </>
          ) : (
            <>
              {sectionLabel ? (
                <SectionLabel
                  label={sectionLabel}
                  compact={compact}
                />
              ) : null}
              {flatHistoryItems.map((item) => renderHistoryRow(item))}
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
            group.items.map((item) => renderHistoryRow(item))
          )}
        </div>
      )) : null}

      {agentsSection}

      {showArchivedHistory ? (
        <div>
          <SectionLabel
            label="Archived"
            compact={compact}
            collapsed={collapsedGroups.archived}
            onToggle={() => toggleGroup('archived')}
          />
          {collapsedGroups.archived ? null : (
            <>
              {combinedArchivedHistory.slice(0, 12).map((item) => renderHistoryRow(item, Boolean(item.archivedAt)))}
              {flatArchivedLanes.map((lane) => (
                <ArchivedLaneCompactRow
                  key={lane.id}
                  lane={lane}
                  onSelectSession={onSelectSession}
                />
              ))}
            </>
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
          onClose={() => setHistoryActionMenu(null)}
          onTogglePin={() => { void togglePinnedHistoryItem(historyActionMenu.item); }}
          onArchive={() => {
            if (historyActionMenu.archived) {
              void restoreHistoryItem(historyActionMenu.item);
            } else {
              void archiveHistoryItem(historyActionMenu.item);
            }
          }}
          onDelete={() => deleteHistoryItem(historyActionMenu.item)}
          onRename={(title) => { void renameHistoryItem(historyActionMenu.item, title); }}
        />
      ) : null}
      {threadHover ? (
        <OrchestratorHoverCard
          title={threadHover.item.title}
          repoLabel={repoSuffix(threadHover.item)}
          backendLabel={threadHover.item.backend
            ? orchestratorBackendDisplayLabel({ backend: threadHover.item.backend, agent: threadHover.item.agent })
            : null}
          packets={ownedPacketsByThread.get(threadHover.item.tabId) ?? []}
          anchorRect={threadHover.rect}
          onMouseEnter={() => {
            clearThreadHoverTimers();
            broadcastThreadLink((ownedPacketsByThread.get(threadHover.item.tabId) ?? []).map((packet) => packet.id));
          }}
          onMouseLeave={() => {
            broadcastThreadLink(null);
            setThreadHover(null);
          }}
        />
      ) : null}
    </div>
  );
}
