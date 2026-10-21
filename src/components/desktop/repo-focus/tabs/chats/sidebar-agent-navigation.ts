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

/** A list projection only: these descriptors are never saved as chat transcripts. */
export function mergeSidebarAgentHistory(history: ChatHistoryItem[], agents: readonly SidebarAgentEntry[]): ChatHistoryItem[] {
  const ids = new Set(history.map(item => item.tabId.replace(/^llm-chat:/, '')));
  const seen = new Set<string>();
  const additions = agents.flatMap(entry => {
    if (seen.has(entry.row.key)) return [];
    seen.add(entry.row.key);
    if (entry.row.sessionKey && ids.has(entry.row.sessionKey.replace(/^llm-chat:/, ''))) return [];
    const timestamp = new Date(Number.isFinite(entry.row.lastActivityAt) ? Math.max(0, entry.row.lastActivityAt) : 0).toISOString();
    return [{
      tabId: sidebarAgentItemId(entry), title: entry.row.name, preview: entry.row.subtitle,
      empty: false, messageCount: 0, model: entry.row.model ?? entry.row.runtime,
      savedAt: timestamp, modifiedAt: timestamp, starred: false, pinned: entry.pinned,
      repoPath: entry.row.repoPath,
    }];
  });
  return [...history, ...additions];
}

export function sidebarAgentPinKeys(row: Pick<ExtraAgentRow, 'key' | 'sessionKey'>): string[] {
  return row.sessionKey ? [row.key, `session:${row.sessionKey}`] : [row.key];
}

export function isSidebarAgentPinned(keys: ReadonlySet<string>, row: Pick<ExtraAgentRow, 'key' | 'sessionKey'>): boolean {
  return sidebarAgentPinKeys(row).some(key => keys.has(key));
}
