'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { requestConfirm, toast } from '@/components/shared/ConfirmToastHost';
import { clearLastOrchestratorThreadForId } from '@/components/desktop/workspace-terminal/orchestrator-thread-restore';
import { canCreateOrchestratorForRepo } from '../../agent-panel-repo-selection';
import {
  normalizeRepoPath,
  packetBelongsToRepo,
  packetVisualState,
  REPO_FOCUS_FONT,
} from '../utils';
import { SessionRow } from './AgentRows';
import { ChatGroupPicker } from './chats/ChatGroupPicker';
import { MissingRepoRailNotice } from './chats/MissingRepoRailNotice';
import { HISTORY_ROW_TONES } from './chats/constants';
import {
  CONVERSATIONS_GROUP_KEY,
  deriveNestedPacketIds,
  historyBelongsToRepo,
  historyRepoContext,
  historyRepoGroupLabel,
  historySection,
  isAutomationSession,
  packetSortTime,
  packetCanNestUnderHistory,
  packetStateTone,
  pickHistoryPacket,
  sessionBelongsToRepo,
  sessionIdentity,
} from './chats/helpers';
import {
  ArchivedLaneCompactRow,
  HistoryChatRow,
  MergedPacketRow,
  OwnedWorkerRow,
} from './chats/HistoryRows';
import { HistoryActionMenu } from './chats/Menus';
import { RepoGroupLabel, SectionLabel } from './chats/shared';
import type {
  ArchivedLaneRow,
  ChatHistoryItem,
  ChatsTabProps,
  HistoryActionMenuState,
  HistoryGroupKey,
  RepoHistoryGroup,
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
  slotBeforeArchived,
  onCreateOrchestratorForRepo,
}: ChatsTabProps) {
  const [historyItems, setHistoryItems] = useState<ChatHistoryItem[]>([]);
  const [archivedHistoryItems, setArchivedHistoryItems] = useState<ChatHistoryItem[]>([]);
  const [archivedLanes, setArchivedLanes] = useState<ArchivedLaneRow[]>([]);
  const [archivedLanesExpanded, setArchivedLanesExpanded] = useState<Set<string>>(() => new Set());

  // Group-by mode for the left-rail chat list (mini / flat variant).
  // Three modes, persisted to localStorage. Borrowed from Claude's
  // sidebar pattern in the operator's reference video — the ⚙ filter
  // icon on a group header opens a Group by / Sort by popover.
  type ChatGroupBy = 'repo' | 'date' | 'flat';
  const CHAT_GROUP_BY_KEY = 'o8:chat-group-by';
  // Default to repo grouping — operator ruling 2026-07-12 (Cursor sidebar
  // siphon): sessions order by repo, each repo is a collapsible drawer.
  // Users who explicitly picked 'date'/'flat' via the picker keep their
  // choice via the localStorage hydration below.
  const [chatGroupBy, setChatGroupBy] = useState<ChatGroupBy>('repo');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(CHAT_GROUP_BY_KEY);
    if (stored === 'repo' || stored === 'date' || stored === 'flat') {
      setChatGroupBy(stored);
    }
  }, []);
  const updateChatGroupBy = useCallback((next: ChatGroupBy) => {
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
  // Ownership nesting (Q ruling 2026-07-12, variant A+B): workers render
  // under the orchestrator thread that spawned them, with a per-thread
  // collapse (default expanded) remembered across reloads.
  const OWNED_COLLAPSED_KEY = 'o8:owned-workers-collapsed';
  const [ownedCollapsedThreads, setOwnedCollapsedThreads] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(OWNED_COLLAPSED_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as unknown;
      if (Array.isArray(parsed)) {
        setOwnedCollapsedThreads(new Set(parsed.filter((key): key is string => typeof key === 'string')));
      }
    } catch { /* ignore */ }
  }, []);
  const toggleOwnedThread = useCallback((threadId: string) => {
    setOwnedCollapsedThreads((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      if (typeof window !== 'undefined') {
        try { window.localStorage.setItem(OWNED_COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
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
  // Group key → registered repo, for the repo-header [+] spawn. Keys match
  // flatHistoryRepoGroups (repo.name lowercased via historyRepoGroupLabel).
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
  const flatHistoryItems = useMemo(() => {
    // Sort by effective modifiedAt desc (mtime OR most-recent click,
    // whichever is later) so clicked chats bubble to the top of the
    // Today bucket immediately. This makes the time-grouped sidebar
    // feel like ChatGPT: open a chat → it pops to top.
    const sorted = [...visibleFlatHistory].sort((a, b) => (
      effectiveModifiedAtMs(b) - effectiveModifiedAtMs(a)
    ));
    if (!Number.isFinite(remainingHistorySlots)) return sorted;
    return sorted.slice(0, Math.max(0, remainingHistorySlots));
  }, [effectiveModifiedAtMs, remainingHistorySlots, visibleFlatHistory]);
  const flatHistoryRepoGroups = useMemo<RepoHistoryGroup[]>(() => {
    const groups = new Map<string, RepoHistoryGroup>();
    for (const item of flatHistoryItems) {
      const rawLabel = historyRepoGroupLabel(item, targetRepos);
      const isConversational = rawLabel === CONVERSATIONS_GROUP_KEY;
      const key = isConversational ? CONVERSATIONS_GROUP_KEY : rawLabel.toLowerCase();
      const label = isConversational ? 'Conversations' : rawLabel;
      const existing = groups.get(key);
      if (existing) {
        existing.items.push(item);
      } else {
        groups.set(key, { key, label, items: [item] });
      }
    }
    // Cursor-parity (mini variant): every registered repo gets a header
    // even with zero sessions — the drawer is the repo's home, and the
    // hover [+] needs somewhere to live before the first session exists.
    // Empty repos append after the ones with history, alphabetically.
    if (variant === 'mini') {
      const emptyRepos = targetRepos
        .filter((repo) => !groups.has(repo.name.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const repo of emptyRepos) {
        groups.set(repo.name.toLowerCase(), { key: repo.name.toLowerCase(), label: repo.name, items: [] });
      }
    }
    // Conversations bucket — free-floating chats not tied to a registered
    // repo — sorts to the bottom, Antigravity-style.
    return [...groups.values()].sort((a, b) => {
      if (a.key === CONVERSATIONS_GROUP_KEY) return 1;
      if (b.key === CONVERSATIONS_GROUP_KEY) return -1;
      return 0;
    });
  }, [flatHistoryItems, targetRepos, variant]);

  // Date-bucket grouping — ChatGPT/Claude-desktop pattern:
  // Today / Yesterday / Previous 7 Days / Previous 30 Days / Older.
  // Used when chatGroupBy === 'date'. Same shape as repo groups so the
  // render loop can stay generic.
  const flatHistoryDateGroups = useMemo<RepoHistoryGroup[]>(() => {
    const today: ChatHistoryItem[] = [];
    const yesterday: ChatHistoryItem[] = [];
    const prev7: ChatHistoryItem[] = [];
    const prev30: ChatHistoryItem[] = [];
    const older: ChatHistoryItem[] = [];

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
    const startOfPrev7 = startOfToday - 7 * 24 * 60 * 60 * 1000;
    const startOfPrev30 = startOfToday - 30 * 24 * 60 * 60 * 1000;

    for (const item of flatHistoryItems) {
      // Use effective time (max of mtime + click time) so a fresh click
      // promotes the item into the Today bucket.
      const ts = effectiveModifiedAtMs(item);
      if (!ts) {
        older.push(item);
        continue;
      }
      if (ts >= startOfToday) today.push(item);
      else if (ts >= startOfYesterday) yesterday.push(item);
      else if (ts >= startOfPrev7) prev7.push(item);
      else if (ts >= startOfPrev30) prev30.push(item);
      else older.push(item);
    }
    const groups: RepoHistoryGroup[] = [];
    if (today.length > 0) groups.push({ key: 'today', label: 'Today', items: today });
    if (yesterday.length > 0) groups.push({ key: 'yesterday', label: 'Yesterday', items: yesterday });
    if (prev7.length > 0) groups.push({ key: 'prev-7', label: 'Previous 7 days', items: prev7 });
    if (prev30.length > 0) groups.push({ key: 'prev-30', label: 'Previous 30 days', items: prev30 });
    if (older.length > 0) groups.push({ key: 'older', label: 'Older', items: older });
    return groups;
  }, [flatHistoryItems, effectiveModifiedAtMs]);

  // Group archived lanes by the same repo-label key used by
  // flatHistoryRepoGroups so we can render them inline under each repo.
  const archivedLanesByRepoKey = useMemo(() => {
    const map = new Map<string, ArchivedLaneRow[]>();
    if (variant !== 'mini' || archivedLanes.length === 0) return map;
    const repoNameByPath = new Map<string, string>();
    for (const repo of targetRepos) {
      repoNameByPath.set(normalizeRepoPath(repo.localPath), repo.name);
    }
    // #1292 — the multiply mints many archived lanes per task (one per
    // reset / redispatch / supervisor-relaunch), and the history list showed
    // every one (e.g. "Add #943" ×4, "lab notes" ×7). Collapse to a single
    // row per (repo, task), keeping the RICHEST sibling: one that still has a
    // sessionKey (→ a reviewable transcript) wins over an anonymized/empty
    // ghost, then most-recent breaks ties. So the kept row is the useful one.
    const byTaskKey = new Map<string, ArchivedLaneRow>();
    for (const lane of archivedLanes) {
      const repoName = repoNameByPath.get(normalizeRepoPath(lane.repoPath));
      if (!repoName) continue;
      const taskKey = `${repoName.toLowerCase()} ${(lane.label ?? lane.branch ?? lane.id).replace(/\s*\(retry \d+\)\s*$/i, '').trim().toLowerCase()}`;
      const existing = byTaskKey.get(taskKey);
      if (!existing) {
        byTaskKey.set(taskKey, lane);
        continue;
      }
      const existingHasSession = Boolean(existing.sessionKey);
      const laneHasSession = Boolean(lane.sessionKey);
      if (existingHasSession !== laneHasSession) {
        if (laneHasSession) byTaskKey.set(taskKey, lane);
      } else if (Date.parse(lane.updatedAt ?? '') > Date.parse(existing.updatedAt ?? '')) {
        byTaskKey.set(taskKey, lane);
      }
    }
    for (const lane of byTaskKey.values()) {
      const repoName = repoNameByPath.get(normalizeRepoPath(lane.repoPath));
      if (!repoName) continue;
      const key = repoName.toLowerCase();
      const bucket = map.get(key);
      if (bucket) bucket.push(lane);
      else map.set(key, [lane]);
    }
    for (const lanes of map.values()) {
      lanes.sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''));
    }
    return map;
  }, [archivedLanes, targetRepos, variant]);

  // Flat archived-lane list for the non-repo grouping modes (flat / date),
  // which have no per-repo bucket to hang archived lanes under. Lets those
  // views show the same Archived section the repo view renders per-repo, so
  // no grouping filter silently hides threads. 2026-05-30.
  const flatArchivedLanes = useMemo(
    () => [...archivedLanesByRepoKey.values()].flat(),
    [archivedLanesByRepoKey],
  );

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
  // Repo drawers count as content when empty: a fresh repo still shows its header and scoped action.
  const showRepoDrawers = compact && groupMode === 'flat' && chatGroupBy === 'repo' && flatHistoryRepoGroups.length > 0;
  // Packets nested under a visible thread row stay out of the bottom Spawned-agents section.
  // Workers whose thread isn't in the rail (archived thread, other repo,
  // external CLI spawn with no thread) keep their bottom-section home.
  const nestedPacketIds = useMemo<ReadonlySet<string>>(() => {
    return deriveNestedPacketIds(flatHistoryItems, ownedPacketsByThread, targetRepos, showRepoDrawers);
  }, [flatHistoryItems, ownedPacketsByThread, showRepoDrawers, targetRepos]);
  const resolvedSlotBeforeArchived = typeof slotBeforeArchived === 'function'
    ? slotBeforeArchived({ nestedPacketIds })
    : slotBeforeArchived;
  const hasContent = displayedSessions.length > 0 || (
    groupMode === 'flat'
      ? flatHistoryItems.length > 0
      : historyGroups.some((group) => group.items.length > 0)
  ) || showRepoDrawers || showMergedPackets || showArchivedHistory;
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

      {groupMode === 'flat' && (flatHistoryItems.length > 0 || showRepoDrawers) ? (
        <div>
          {compact ? (
            <>
              {chatGroupBy === 'flat' ? (
                <>
                  {/* No group header in flat mode — render the picker as
                      its own thin row aligned right. */}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 8, paddingRight: 10, paddingBottom: 2 }}>
                    <ChatGroupPicker mode={chatGroupBy} onChange={updateChatGroupBy} />
                  </div>
                  {flatHistoryItems.map((item) => (
                    <HistoryChatRow
                      key={item.tabId}
                      item={item}
                      compact={compact}
                      disabled={!onOpenHistoryChat}
                      active={activeSessionKey === item.tabId || activeSessionKey === `llm-chat:${item.tabId}`}
                      tone={packetStateTone(historyPacketsByTabId.get(item.tabId))}
                      onOpen={() => { onOpenHistoryChat?.(item.tabId, item.title, historyRepoContext(item)); }}
                      onOpenMenu={(event) => setHistoryActionMenu({ item, archived: false, x: event.clientX, y: event.clientY })}
                    />
                  ))}
                </>
              ) : chatGroupBy === 'date' ? (
                flatHistoryDateGroups.map((group, index) => (
                  <div key={group.key}>
                    <RepoGroupLabel
                      label={group.label}
                      trailing={index === 0 ? <ChatGroupPicker mode={chatGroupBy} onChange={updateChatGroupBy} /> : null}
                    />
                    {group.items.map((item) => (
                      <HistoryChatRow
                        key={item.tabId}
                        item={item}
                        compact={compact}
                        disabled={!onOpenHistoryChat}
                        active={activeSessionKey === item.tabId || activeSessionKey === `llm-chat:${item.tabId}`}
                        tone={packetStateTone(historyPacketsByTabId.get(item.tabId))}
                        onOpen={() => { onOpenHistoryChat?.(item.tabId, item.title, historyRepoContext(item)); }}
                        onOpenMenu={(event) => setHistoryActionMenu({ item, archived: false, x: event.clientX, y: event.clientY })}
                      />
                    ))}
                  </div>
                ))
              ) : (
                flatHistoryRepoGroups.map((group, index) => {
                  const repoArchivedLanes = archivedLanesByRepoKey.get(group.key) ?? [];
                  const archivedExpanded = archivedLanesExpanded.has(group.key);
                  const isLast = index === flatHistoryRepoGroups.length - 1;
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
                      {groupCollapsed ? null : (
                        <>
                          {group.items.map((item) => {
                            const ownedPackets = (ownedPacketsByThread.get(item.tabId) ?? [])
                              .filter((packet) => packetCanNestUnderHistory(item, packet, targetRepos));
                            const ownedExpanded = !ownedCollapsedThreads.has(item.tabId);
                            return (
                              <div key={item.tabId}>
                                <HistoryChatRow
                                  item={item}
                                  compact={compact}
                                  disabled={!onOpenHistoryChat}
                                  active={activeSessionKey === item.tabId || activeSessionKey === `llm-chat:${item.tabId}`}
                                  tone={packetStateTone(historyPacketsByTabId.get(item.tabId))}
                                  onOpen={() => { onOpenHistoryChat?.(item.tabId, item.title, historyRepoContext(item)); }}
                                  onOpenMenu={(event) => setHistoryActionMenu({ item, archived: false, x: event.clientX, y: event.clientY })}
                                  ownedCount={ownedPackets.length}
                                  ownedExpanded={ownedExpanded}
                                  onToggleOwned={ownedPackets.length > 0 ? () => toggleOwnedThread(item.tabId) : undefined}
                                />
                                {ownedExpanded ? ownedPackets.map((packet) => (
                                  <OwnedWorkerRow key={packet.id} packet={packet} />
                                )) : null}
                              </div>
                            );
                          })}
                          {/* A fresh repo keeps its scoped empty state until its first session appears. */}
                          {group.items.length === 0 && !isConversations && !groupRepoMissing ? (
                            <div
                              style={{
                                paddingTop: 3,
                                paddingRight: 12,
                                paddingBottom: 5,
                                paddingLeft: 37,
                                fontSize: 11,
                                lineHeight: '15px',
                                fontWeight: 300,
                                color: 'var(--t-text-faint)',
                                fontFamily: REPO_FOCUS_FONT,
                              }}
                            >
                              No sessions yet
                            </div>
                          ) : null}
                          {/* Slot renders inside the LAST repo group, after
                              the chats but BEFORE this repo's inline Archived
                              section — the operator's hierarchy is chats →
                              spawned → archived. */}
                          {isLast ? resolvedSlotBeforeArchived : null}
                          {repoArchivedLanes.length > 0 ? (
                            <>
                              <SectionLabel
                                label="Archived"
                                compact={compact}
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
                        </>
                      )}
                      {/* Spawned agents stay "down there" even when the last
                          repo's drawer is minimized. */}
                      {groupCollapsed && isLast ? resolvedSlotBeforeArchived : null}
                    </div>
                  );
                })
              )}
              {/* Parity trailer (2026-05-30): flat + date modes surface the
                  same Spawned agents + Archived sections the repo mode renders
                  inline above, so every grouping filter exposes the complete
                  thread set — no chats hidden by the grouping choice. */}
              {chatGroupBy !== 'repo' ? (
                <>
                  {resolvedSlotBeforeArchived}
                  {flatArchivedLanes.length > 0 ? (
                    <>
                      <SectionLabel
                        label="Archived"
                        compact={compact}
                        collapsed={collapsedGroups.archived}
                        onToggle={() => toggleGroup('archived')}
                      />
                      {collapsedGroups.archived ? null : flatArchivedLanes.map((lane) => (
                        <ArchivedLaneCompactRow
                          key={lane.id}
                          lane={lane}
                          onSelectSession={onSelectSession}
                        />
                      ))}
                    </>
                  ) : null}
                </>
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
              {flatHistoryItems.map((item) => (
                <HistoryChatRow
                  key={item.tabId}
                  item={item}
                  compact={compact}
                  disabled={!onOpenHistoryChat}
                  active={activeSessionKey === item.tabId || activeSessionKey === `llm-chat:${item.tabId}`}
                  tone={packetStateTone(historyPacketsByTabId.get(item.tabId))}
                  onOpen={() => { onOpenHistoryChat?.(item.tabId, item.title, historyRepoContext(item)); }}
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
                tone={packetStateTone(historyPacketsByTabId.get(item.tabId))}
                onOpen={() => { onOpenHistoryChat?.(item.tabId, item.title, historyRepoContext(item)); }}
                onOpenMenu={(event) => setHistoryActionMenu({ item, archived: false, x: event.clientX, y: event.clientY })}
              />
            ))
          )}
        </div>
      )) : null}

      {/* Non-compact repo view appends Spawned agents after the chat sections.
          Compact modes render it inline instead: repo mode in the last repo
          group, flat/date modes in the parity trailer above — so every grouping
          filter surfaces the same complete thread set. */}
      {chatGroupBy === 'repo'
        && !(compact && flatHistoryRepoGroups.length > 0)
        ? resolvedSlotBeforeArchived
        : null}

      {showArchivedHistory ? (
        <div>
          <SectionLabel
            label="Archived"
            compact={compact}
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
                onOpen={() => { onOpenHistoryChat?.(item.tabId, item.title, historyRepoContext(item)); }}
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
    </div>
  );
}
