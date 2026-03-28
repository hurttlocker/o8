import type { WorkflowStageBadge } from '@/lib/workflows/status';

export interface WorkspaceLifecycleActionView {
  available: boolean;
  detail: string;
  unavailableReason?: string;
}

export interface WorkspaceLifecycleRecordView {
  id: string;
  repo: string;
  repoPath: string;
  workspacePath: string;
  branch: string;
  repoSlug?: string | null;
  sessionKey?: string | null;
  runtime?: string | null;
  agentName?: string | null;
  agentStatus?: string | null;
  currentTask?: string | null;
  workspaceStatus?: 'in_progress' | 'in_review' | 'done' | 'idle' | 'cancelled' | null;
  workflowStage?: WorkflowStageBadge | null;
  live: boolean;
  archivedAt?: string | null;
  restoredAt?: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastActivityAt?: string | null;
  lastReadAt?: string | null;
  unreadCount: number;
  hasHistory: boolean;
  attentionRank: number;
  attentionLabel: string;
  attentionDetail: string;
  archive: WorkspaceLifecycleActionView;
  resume: WorkspaceLifecycleActionView;
}

export interface WorkspaceLifecycleSummaryView {
  unreadCount: number;
  archivedCount: number;
  nextAttentionWorkspaceId: string | null;
}
