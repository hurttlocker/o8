import type { CanvasTab } from '@/components/desktop/Canvas';
import type { WorkspaceSidePanelRepo } from '@/components/desktop/WorkspaceSidePanel';
import type { RepoReadiness } from '@/lib/repos/types';
import type { WorktreeInfo } from '@/lib/worktree/types';
import type { WorkflowStageBadge } from '@/lib/workflows/status';

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
