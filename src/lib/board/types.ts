import type { AgentSummary } from '@/lib/fleet/types';
import type { WorkflowRunStatus } from '@/lib/workflows/types';
import type { WorktreeInfo } from '@/lib/worktree/types';

export type BoardColumnId = 'backlog' | 'in_progress' | 'review' | 'trash';
export type BoardRuntimeId = 'codex' | 'claude-code';
export type BoardArchiveReason = 'completed' | 'discarded';

export interface BoardTaskBindings {
  runtime?: BoardRuntimeId | null;
  runtimeSurfaceId?: string | null;
  sessionId?: string | null;
  worktreeId?: string | null;
  worktreePath?: string | null;
  issueId?: number | null;
  prId?: number | null;
}

export interface BoardTaskArchivedRuntime {
  runtime?: BoardRuntimeId | null;
  runtimeSurfaceId?: string | null;
  sessionId?: string | null;
  worktreeId?: string | null;
  worktreePath?: string | null;
  archivedAt?: string | null;
}

export interface BoardTaskAutomation {
  startInPlanMode: boolean;
  autoReviewEnabled?: boolean;
  autoReviewMode?: 'commit' | 'pr' | 'move_to_trash';
}

export interface BoardTask {
  id: string;
  title: string;
  prompt: string;
  preferredRuntime: BoardRuntimeId;
  baseBranch: string;
  notes?: string | null;
  workflowState?: WorkflowRunStatus | null;
  archiveReason?: BoardArchiveReason | null;
  archivedAt?: string | null;
  archivedFromColumn?: Exclude<BoardColumnId, 'trash'> | null;
  archivedRuntime?: BoardTaskArchivedRuntime | null;
  createdAt: string;
  updatedAt: string;
  bindings: BoardTaskBindings;
  automation: BoardTaskAutomation;
}

export interface BoardDependency {
  id: string;
  fromTaskId: string;
  toTaskId: string;
  createdAt: string;
}

export interface BoardColumn {
  id: BoardColumnId;
  title: string;
  taskIds: string[];
}

export interface BoardState {
  version: 1;
  revision: number;
  repoPath: string;
  repoSlug: string | null;
  defaultBaseBranch: string;
  updatedAt: string;
  columns: BoardColumn[];
  tasks: Record<string, BoardTask>;
  dependencies: BoardDependency[];
}

export interface BoardTaskInput {
  title: string;
  prompt?: string;
  preferredRuntime?: BoardRuntimeId;
  baseBranch?: string | null;
  issueId?: number | null;
  prId?: number | null;
  startInPlanMode?: boolean;
}

export interface BoardTaskPatch {
  title?: string;
  prompt?: string;
  preferredRuntime?: BoardRuntimeId;
  baseBranch?: string | null;
  issueId?: number | null;
  prId?: number | null;
  startInPlanMode?: boolean;
  workflowState?: WorkflowRunStatus | null;
  bindings?: Partial<BoardTaskBindings>;
}

export type BoardMutation =
  | {
      type: 'create_task';
      columnId?: BoardColumnId;
      task: BoardTaskInput;
    }
  | {
      type: 'update_task';
      taskId: string;
      patch: BoardTaskPatch;
    }
  | {
      type: 'reorder_task';
      taskId: string;
      columnId: BoardColumnId;
      toIndex?: number;
    }
  | {
      type: 'mark_review_ready';
      taskId: string;
    }
  | {
      type: 'archive_task';
      taskId: string;
      reason: BoardArchiveReason;
    }
  | {
      type: 'restore_task';
      taskId: string;
      toIndex?: number;
    }
  | {
      type: 'add_dependency';
      fromTaskId: string;
      toTaskId: string;
    }
  | {
      type: 'remove_dependency';
      dependencyId: string;
    };

export interface BoardRuntimeOption {
  id: BoardRuntimeId;
  label: string;
  supportsWorktree: boolean;
  launchBehavior: 'owned' | 'provider';
}

export interface BoardTaskView extends BoardTask {
  columnId: BoardColumnId;
  blocked: boolean;
  blockedByTaskIds: string[];
  blockedByTitles: string[];
  dependentTaskIds: string[];
  dependencyIds: string[];
  startable: boolean;
  reviewReady: boolean;
  runtimeSession: AgentSummary | null;
  worktree: WorktreeInfo | null;
}

export interface BoardColumnView {
  id: BoardColumnId;
  title: string;
  tasks: BoardTaskView[];
}

export interface BoardSnapshot {
  state: BoardState;
  columns: BoardColumnView[];
  startableTaskIds: string[];
  availableRuntimes: BoardRuntimeOption[];
}
