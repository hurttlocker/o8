import type { ReactNode } from 'react';
import type { SavedChatRepoContext } from '@/lib/llm/chat-history';
import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { OrchestratorPacket, OrchestratorRuntime } from '@/lib/orchestrator/types';
import type { IdeWorkspaceSession, RepoFocusRepo } from '../../types';

export interface ChatHistoryItem {
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
  backend?: OrchestratorBackendId | null;
  agent?: string | null;
  archivedAt?: string | null;
}

export interface ArchivedLaneRow {
  id: string;
  label: string;
  repoPath: string;
  branch: string;
  baseBranch: string;
  runtime: OrchestratorRuntime;
  sessionKey: string | null;
  updatedAt: string;
  status?: string;
}

export interface ChatsTabProps {
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
  /** Flat Agents section rendered between Chats and Archived. */
  agentsSection?: ReactNode;
  /** When set (mini variant, repo grouping), each repo group header gets a
   *  hover-revealed [+] that spawns a fresh orchestrator session scoped to
   *  that repo — Cursor's contextual New Agent pattern. */
  onCreateOrchestratorForRepo?: (repo: RepoFocusRepo) => void;
}

export interface HistoryActionMenuState {
  item: ChatHistoryItem;
  archived: boolean;
  x: number;
  y: number;
}

export type HistoryToneKey = 'neutral' | 'activity' | 'running' | 'review' | 'merged' | 'failed' | 'active';

export interface HistoryRowTone {
  key: HistoryToneKey;
  accent: string;
  background: string;
  border: string;
  iconBackground: string;
  iconColor: string;
  label?: string;
}

export type HistoryGroupKey = 'chat' | 'orchestrator' | 'merged' | 'archived';

export interface RepoHistoryGroup {
  key: string;
  label: string;
  items: ChatHistoryItem[];
}
