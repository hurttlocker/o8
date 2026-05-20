'use client';

import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type {
  OrchestratorMissionState,
  OrchestratorPacket,
} from '@/lib/orchestrator/types';
import type { RepoReadiness, RepoRegistryEntry } from '@/lib/repos/types';
import type { SavedChatRepoContext } from '@/lib/llm/chat-history';

export type RepoFocusTabId = 'control' | 'chats' | 'agents' | 'context' | 'mission' | 'spec';
export type RepoFocusPacketState = 'queued' | 'running' | 'awaiting_review' | 'merged' | 'failed';
export type IdeWorkspaceSession = MobileInboxSnapshot['sessions'][number];

export interface RepoFocusRepo {
  id: string;
  name: string;
  localPath: string;
  remoteUrl: string | null;
  defaultBranch: string;
  readiness?: RepoReadiness;
}

export interface LeftPanelFocusState {
  focusActive: boolean;
  focusedRepoPath: string;
  focusedRepo: RepoFocusRepo | null;
  focusByRepoId: (repoId: string) => void;
  clearFocus: () => void;
}

export interface RepoFocusDataProps {
  packets: OrchestratorPacket[];
  missionState?: OrchestratorMissionState;
  ideWorkspaceSessions?: IdeWorkspaceSession[];
  activeSessionKey?: string | null;
  onSelectSession?: (sessionKey: string) => void;
  onOpenHistoryChat?: (historyTabId: string, title: string, repo?: SavedChatRepoContext | null) => void;
  onOpenSpecInWorkspace?: (repoPath: string) => void;
}

export function toRepoFocusRepo(repo: RepoRegistryEntry): RepoFocusRepo {
  return {
    id: repo.id,
    name: repo.name,
    localPath: repo.localPath,
    remoteUrl: repo.remoteUrl,
    defaultBranch: repo.defaultBranch,
    readiness: repo.readiness,
  };
}
