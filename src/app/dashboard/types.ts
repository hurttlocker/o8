import type { Dispatch, SetStateAction } from 'react';
import type { CanvasTab } from '@/components/desktop/Canvas';
import type { WsConnectionState } from '@/components/desktop/hooks/DesktopWebSocketContext';
import type { RepoReadiness } from '@/lib/repos/types';
import type { WorktreeInfo } from '@/lib/worktree/types';
import type { WorkspaceLifecycleRecordView, WorkspaceLifecycleSummaryView } from '@/lib/workspace/lifecycle-types';
import type { WorkflowStageBadge } from '@/lib/workflows/status';

// Retired NavRail's `NavSection` type — kept here so the dashboard hooks
// that flip the section (useUIChrome, useGlobalRepoState,
// useSettingsOverlayDismiss) can keep their existing imports.
export type NavSection = 'agents' | 'automations' | 'customize' | 'analytics' | 'settings';

// Lifted out of the retired workspace-side-panel module so callers can
// keep importing from the same dashboard/types barrel.
export interface WorkspaceSidePanelRepo {
  name: string;
  localPath: string;
  branch?: string | null;
  readiness?: RepoReadiness | null;
  remoteUrl?: string;
  isWorktree?: boolean;
  worktreeStatus?: string | null;
}

export type WorkspaceSidePanelView = 'blank' | 'diff' | 'git-log';

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

export interface WorkspaceChatTargetOption {
  sessionKey: string;
  label: string;
  detail: string | null;
}

export interface PaletteAgentSummary {
  id: string;
  name: string;
  status?: string;
  currentTask?: string;
  sessionKey: string;
  surfaceLabel?: string;
  tmuxSession?: string;
  alerts?: number;
  approvalStatus?: string;
  isCurrentSession?: boolean;
  lastEventAt?: string;
  workspace?: string;
  branch?: string;
  workspaceStatus?: string;
  lifecycleState?: string;
  workflowStage?: WorkflowStageBadge | null;
  runtime?: string;
  localDiff?: {
    changedFiles?: number;
    additions?: number;
    deletions?: number;
  };
  activity?: {
    headline?: string;
    filePath?: string;
    timestamp?: number;
  };
  repoReadiness?: RepoReadiness;
  pr?: {
    number: number;
    title: string;
    state?: 'open' | 'merged' | 'closed';
    url?: string;
  };
  runtimeSurface?: {
    cwd?: string | null;
    ownership?: 'provider' | 'discovered' | 'owned';
    capabilities?: {
      sendInput?: boolean;
      interrupt?: boolean;
    };
    lifecycle?: {
      availability?: string;
      summary?: string;
    };
    reviewContext?: {
      repoSlug?: string | null;
    };
  };
  worktree?: WorktreeInfo | null;
}

export interface RepoWorktreeSummary {
  worktrees: WorktreeInfo[];
  conflicts: {
    safe: boolean;
    count: number;
  };
  totalDiskUsage: number;
}

export interface WorkspaceScopeEntry extends WorkspaceSidePanelRepo {
  registryRepoId?: string;
  isWorktree?: boolean;
  worktreeStatus?: WorktreeInfo['status'] | null;
}

export interface CanvasTileState {
  tabs: CanvasTab[];
  activeTabId: string | null;
  revealKey: number;
}

export interface FtuxFirstChangedFile {
  path: string;
  workspace: string | null;
}

export type WorkspaceLifecycleMutationAction = 'archive' | 'restore' | 'mark_read';

export interface UseWorkspaceLifecycleArgs {
  currentReviewAgent: PaletteAgentSummary | null;
  globalRepoPath: string | null;
  scopedRepoAgents: PaletteAgentSummary[];
  selectedSessionAgent: PaletteAgentSummary | null;
  workspaceTerminalPreferredRepoPath: string | null;
  wsStatus: WsConnectionState;
}

export interface UseWorkspaceLifecycleResult {
  archivedWorkspaceCandidate: WorkspaceLifecycleRecordView | null;
  currentWorkspaceLifecycleRecord: WorkspaceLifecycleRecordView | null;
  mutateWorkspaceLifecycle: (action: WorkspaceLifecycleMutationAction, workspaceId: string) => Promise<void>;
  nextAttentionWorkspace: WorkspaceLifecycleRecordView | null;
  refreshWorkspaceLifecycle: () => Promise<void>;
  setWorkspaceLifecycleRecords: Dispatch<SetStateAction<WorkspaceLifecycleRecordView[]>>;
  setWorkspaceLifecycleSummary: Dispatch<SetStateAction<WorkspaceLifecycleSummaryView>>;
  workspaceLifecycleRecords: WorkspaceLifecycleRecordView[];
  workspaceLifecycleSummary: WorkspaceLifecycleSummaryView;
}
