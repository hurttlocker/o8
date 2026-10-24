import type { ReactNode } from 'react';
import type { ExtraAgentRow } from '../../../AgentPanelExtraAgentRow';
import type { AttentionSubject } from './sections';
import type { ChatHistoryItem } from './types';

export interface ChatViewAction {
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

export interface SidebarAgentEntry {
  row: ExtraAgentRow;
  pinned: boolean;
  active: boolean;
  attention: AttentionSubject;
  render: (options: { roomy: boolean; showPreview: boolean; repoLabel: string | null }) => ReactNode;
}

export const EMPTY_SIDEBAR_AGENTS: readonly SidebarAgentEntry[] = [];
export const EMPTY_CHAT_VIEW_ACTIONS: readonly ChatViewAction[] = [];
export const sidebarAgentItemId = (entry: SidebarAgentEntry) => `sidebar-agent:${entry.row.key}`;

const ARCHIVED_WORKER_STATUSES = new Set(['completed', 'closed', 'archived', 'merged', 'released']);
const isArchivedWorker = (entry: SidebarAgentEntry) => ARCHIVED_WORKER_STATUSES.has(entry.row.laneStatus ?? entry.row.status);
const workerTimestamp = (entry: SidebarAgentEntry) => new Date(Number.isFinite(entry.row.lastActivityAt) ? Math.max(0, entry.row.lastActivityAt) : 0).toISOString();

/** A list projection only: these descriptors are never saved as chat transcripts. */
export function mergeSidebarAgentHistory(history: ChatHistoryItem[], agents: readonly SidebarAgentEntry[]): ChatHistoryItem[] {
  const ids = new Set(history.map(item => item.tabId.replace(/^llm-chat:/, '')));
  const archivedSessions = new Map(agents.filter(isArchivedWorker).flatMap(entry => entry.row.sessionKey
    ? [[entry.row.sessionKey.replace(/^llm-chat:/, ''), workerTimestamp(entry)] as const] : []));
  const projectedHistory = history.map(item => {
    const archivedAt = archivedSessions.get(item.tabId.replace(/^llm-chat:/, ''));
    return archivedAt ? { ...item, archivedAt } : item;
  });
  const seen = new Set<string>();
  const additions = agents.flatMap(entry => {
    if (seen.has(entry.row.key)) return [];
    seen.add(entry.row.key);
    if (entry.row.sessionKey && ids.has(entry.row.sessionKey.replace(/^llm-chat:/, ''))) return [];
    const timestamp = workerTimestamp(entry);
    return [{
      tabId: sidebarAgentItemId(entry), title: entry.row.name, preview: entry.row.subtitle,
      empty: false, messageCount: 0, model: entry.row.model ?? entry.row.runtime,
      savedAt: timestamp, modifiedAt: timestamp, starred: false, pinned: entry.pinned,
      archivedAt: isArchivedWorker(entry) ? timestamp : undefined,
      repoPath: entry.row.repoPath,
    }];
  });
  return [...projectedHistory, ...additions];
}

export function sidebarAgentPinKeys(row: Pick<ExtraAgentRow, 'key' | 'sessionKey'>): string[] {
  return row.sessionKey ? [row.key, `session:${row.sessionKey}`] : [row.key];
}

export function isSidebarAgentPinned(keys: ReadonlySet<string>, row: Pick<ExtraAgentRow, 'key' | 'sessionKey'>): boolean {
  return sidebarAgentPinKeys(row).some(key => keys.has(key));
}
