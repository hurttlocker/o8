import { normalizeRepoPath } from '../../utils';
import { CONVERSATIONS_GROUP_KEY, historyRepoGroupLabel } from './helpers';
import type { RepoFocusRepo } from '../../types';
import type { ArchivedLaneRow, ChatHistoryItem, RepoHistoryGroup } from './types';

/**
 * Cross-section hover link: hovering an orchestrator thread row broadcasts its
 * owned packet ids so the Agents section can light them up and dim the rest.
 * detail: { packetIds: string[] | null } — null clears the link.
 */
export const SIDEBAR_HOVER_THREAD_EVENT = 'o8:sidebar-hover-thread';

export type AttentionBand =
  | 'failed'
  | 'rejected'
  | 'human'
  | 'review'
  | 'merged'
  | 'in-flight'
  | 'settled'
  | 'neutral';

export interface AttentionSubject {
  status?: string | null;
  rejected?: boolean;
  outcome?: string | null;
  unread?: boolean;
}

const ATTENTION_RANK: Record<AttentionBand, number> = {
  failed: 5,
  rejected: 4,
  human: 3,
  review: 2,
  merged: 1,
  'in-flight': 0,
  settled: 0,
  neutral: 0,
};

const FAILED_STATUSES = new Set(['blocked', 'error', 'failed', 'recovering']);
const HUMAN_STATUSES = new Set(['awaiting_human', 'awaiting_input', 'input', 'waiting']);
const REVIEW_STATUSES = new Set(['approval', 'awaiting_review', 'review', 'reviewing']);
const IN_FLIGHT_STATUSES = new Set([
  'active',
  'awaiting_orchestrator',
  'idle',
  'launching',
  'merging',
  'paused',
  'queued',
  'running',
  'working',
]);
const TERMINAL_STATUSES = new Set(['archived', 'completed', 'merged', 'released']);

function normalized(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function attentionBand(subject: AttentionSubject): AttentionBand {
  const status = normalized(subject.status);
  const outcome = normalized(subject.outcome);
  if (FAILED_STATUSES.has(status)) return 'failed';
  if (subject.rejected || status === 'rejected') return 'rejected';
  if (HUMAN_STATUSES.has(status) || outcome === 'asked') return 'human';
  if (REVIEW_STATUSES.has(status) || outcome === 'pr_opened') return 'review';
  if ((outcome === 'merged' || status === 'merged' || status === 'released') && subject.unread) {
    return 'merged';
  }
  if (IN_FLIGHT_STATUSES.has(status)) return 'in-flight';
  if (outcome || TERMINAL_STATUSES.has(status)) return 'settled';
  return 'neutral';
}

export function attentionRank(subject: AttentionSubject): number {
  return ATTENTION_RANK[attentionBand(subject)];
}

export function derivePrioritySplit<T extends AttentionSubject & { modifiedAt: string }>(
  items: T[],
): { priority: T[]; remainder: T[] } {
  const priority: T[] = [];
  const remainder: T[] = [];
  for (const item of items) {
    (attentionRank(item) > 0 ? priority : remainder).push(item);
  }
  priority.sort((left, right) => (
    attentionRank(right) - attentionRank(left)
      || Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt)
  ));
  return { priority, remainder };
}

export function shouldRecede({
  band,
  active,
  hovered,
}: {
  band: AttentionBand;
  active: boolean;
  hovered: boolean;
}): boolean {
  if (active || hovered) return false;
  return band === 'in-flight' || band === 'settled';
}

export function isCompletionUnread(
  completionAt: string | number | null | undefined,
  lastVisited: number | null,
): boolean {
  if (lastVisited == null) return false;
  const completedAt = typeof completionAt === 'number'
    ? completionAt
    : Date.parse(completionAt ?? '');
  return Number.isFinite(completedAt) && completedAt > lastVisited;
}

export function deriveSweptThreads(
  items: ChatHistoryItem[],
  {
    activeSessionKey,
    liveThreadIds = new Set<string>(),
    now = Date.now(),
  }: {
    activeSessionKey?: string | null;
    liveThreadIds?: ReadonlySet<string>;
    now?: number;
  } = {},
): { chats: ChatHistoryItem[]; swept: ChatHistoryItem[] } {
  const activeThreadId = (activeSessionKey ?? '').replace(/^llm-chat:/, '');
  const chats: ChatHistoryItem[] = [];
  const swept: ChatHistoryItem[] = [];
  const staleBefore = now - 48 * 60 * 60 * 1000;

  for (const item of items) {
    const modifiedAt = Date.parse(item.modifiedAt);
    const disposable = item.empty
      || item.messageCount <= 1
      || /^(new chat|new session|untitled)\s*$/i.test(item.title.trim());
    const shouldSweep = !item.pinned
      && !item.starred
      && item.tabId !== activeThreadId
      && !liveThreadIds.has(item.tabId)
      && disposable
      && Number.isFinite(modifiedAt)
      && modifiedAt < staleBefore;
    (shouldSweep ? swept : chats).push(item);
  }

  return { chats, swept };
}

export function deriveShowRepoSuffix(
  items: Array<{ repoName?: string | null; repoPath?: string | null }>,
): boolean {
  const repos = new Set(items.map((item) => (
    item.repoPath?.trim().replace(/\/\.cortex-worktrees\/.*$/, '').replace(/\/+$/, '')
      || item.repoName?.trim()
      || ''
  )).filter(Boolean));
  return repos.size > 1;
}

export function repoSuffix(item: { repoName?: string | null; repoPath?: string | null }): string | null {
  const name = item.repoName?.trim();
  if (name) return name;
  return item.repoPath
    ?.replace(/\/\.cortex-worktrees\/.*$/, '')
    .split('/')
    .filter(Boolean)
    .at(-1) ?? null;
}

export function deriveHistoryRepoGroups(
  items: ChatHistoryItem[],
  repos: RepoFocusRepo[],
): RepoHistoryGroup[] {
  const groups = new Map<string, RepoHistoryGroup>();
  for (const item of items) {
    const rawLabel = historyRepoGroupLabel(item, repos);
    const conversational = rawLabel === CONVERSATIONS_GROUP_KEY;
    const key = conversational ? CONVERSATIONS_GROUP_KEY : rawLabel.toLowerCase();
    const existing = groups.get(key);
    if (existing) existing.items.push(item);
    else groups.set(key, {
      key,
      label: conversational ? 'Conversations' : rawLabel,
      items: [item],
    });
  }
  return [...groups.values()].sort((left, right) => {
    if (left.key === CONVERSATIONS_GROUP_KEY) return 1;
    if (right.key === CONVERSATIONS_GROUP_KEY) return -1;
    return left.label.localeCompare(right.label);
  });
}

export function deriveHistoryDateGroups(
  items: ChatHistoryItem[],
  now = new Date(),
): RepoHistoryGroup[] {
  const buckets = new Map<string, RepoHistoryGroup>([
    ['today', { key: 'today', label: 'Today', items: [] }],
    ['yesterday', { key: 'yesterday', label: 'Yesterday', items: [] }],
    ['prev-7', { key: 'prev-7', label: 'Previous 7 days', items: [] }],
    ['prev-30', { key: 'prev-30', label: 'Previous 30 days', items: [] }],
    ['older', { key: 'older', label: 'Older', items: [] }],
  ]);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  for (const item of items) {
    const timestamp = Date.parse(item.modifiedAt);
    const age = startOfToday - timestamp;
    const key = !Number.isFinite(timestamp) || age >= 30 * 24 * 60 * 60 * 1000
      ? 'older'
      : age >= 7 * 24 * 60 * 60 * 1000
        ? 'prev-30'
        : age >= 24 * 60 * 60 * 1000
          ? 'prev-7'
          : timestamp < startOfToday
            ? 'yesterday'
            : 'today';
    buckets.get(key)?.items.push(item);
  }
  return [...buckets.values()].filter((group) => group.items.length > 0);
}

export function deriveArchivedLanes(
  lanes: ArchivedLaneRow[],
  repoPaths: string[],
): ArchivedLaneRow[] {
  const normalizedRepos = repoPaths.map(normalizeRepoPath).filter(Boolean);
  const byTask = new Map<string, ArchivedLaneRow>();
  for (const lane of lanes) {
    const laneRepo = normalizeRepoPath(lane.repoPath);
    if (!normalizedRepos.some((repo) => laneRepo === repo || laneRepo.startsWith(`${repo}/`))) continue;
    const label = (lane.label || lane.branch || lane.id).replace(/\s*\(retry \d+\)\s*$/i, '').trim();
    const key = `${laneRepo}\u0000${label.toLowerCase()}`;
    const existing = byTask.get(key);
    if (!existing
      || (Boolean(lane.sessionKey) && !existing.sessionKey)
      || (Boolean(lane.sessionKey) === Boolean(existing.sessionKey)
        && Date.parse(lane.updatedAt) > Date.parse(existing.updatedAt))) {
      byTask.set(key, lane);
    }
  }
  return [...byTask.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
