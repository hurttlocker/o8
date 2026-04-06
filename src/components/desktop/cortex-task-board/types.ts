import type { ReactNode } from 'react';
import type { BoardColumnId, BoardSnapshot, BoardTaskView } from '@/lib/board/types';
import type { WorkflowReviewSnapshot } from '@/lib/fleet/types';

export type BoardComposerState = {
  title: string;
  prompt: string;
  preferredRuntime: 'codex' | 'claude-code';
  baseBranch: string;
  issueId: string;
  prId: string;
  startInPlanMode: boolean;
};

export type BoardEditorState = BoardComposerState;

export type DependencyDraft = {
  sourceTaskId: string;
  targetTaskId: string | null;
  pointerClientX: number;
  pointerClientY: number;
};

export type TaskAnchor = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerX: number;
  centerY: number;
  columnId: BoardColumnId | null;
};

export type DependencyLayout = {
  width: number;
  height: number;
  anchors: Record<string, TaskAnchor>;
};

export type RenderedDependency = {
  id: string;
  path: string;
  midpointX: number;
  midpointY: number;
};

export type BoardDropTarget = {
  columnId: BoardColumnId;
  index: number;
} | null;

export type RepoIssueSummary = {
  number: number;
  title: string;
  body: string;
  state: string;
  comments: number;
  createdAt?: string;
  updatedAt?: string;
  url: string;
  labels: Array<{ name: string; color: string }>;
  author?: { login?: string | null } | null;
  assignees?: Array<{ login?: string | null }>;
};

export type StatusTone = {
  label: string;
  color: string;
  background: string;
  border: string;
};

export type DependencyOption = {
  id: string;
  label: string;
};

export interface BoardFormProps {
  value: BoardComposerState;
  availableRuntimes: BoardSnapshot['availableRuntimes'];
  onChange: (value: BoardComposerState) => void;
}

export interface LabeledFieldProps {
  label: string;
  children: ReactNode;
}

export interface DependencyRowProps {
  label: string;
  onRemove?: () => void;
}

export interface MetricChipProps {
  label: string;
  value: number;
  tone: 'blue' | 'orange' | 'green';
}

export interface BoardPillProps {
  children: ReactNode;
}

export interface TaskCardProps {
  task: BoardTaskView;
  columnId: BoardColumnId;
  taskIndex: number;
  selectedTaskId: string | null;
  dragTaskId: string | null;
  dropTarget: BoardDropTarget;
  dependencyDraft: DependencyDraft | null;
  startBusyTaskId: string | null;
  mutationBusy: string | null;
  onSelect: (taskId: string) => void;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
  onDragOver: (columnId: BoardColumnId, index: number) => void;
  onDrop: (taskId: string, columnId: BoardColumnId, index: number) => void;
  onDependencyDraftStart: (taskId: string, clientX: number, clientY: number) => void;
  onStartTask: (taskId: string) => void;
  onMarkReviewReady: (taskId: string) => void;
  onArchiveTask: (taskId: string, reason: 'completed' | 'discarded') => void;
  onRestoreTask: (taskId: string) => void;
}

export interface TaskColumnProps {
  column: BoardSnapshot['columns'][number];
  backlogIssues: RepoIssueSummary[];
  issuesLoading: boolean;
  issuesError: string | null;
  selectedIssue: RepoIssueSummary | null;
  selectedTaskId: string | null;
  dragTaskId: string | null;
  dropTarget: BoardDropTarget;
  dependencyDraft: DependencyDraft | null;
  startBusyTaskId: string | null;
  issueStartBusyNumber: number | null;
  mutationBusy: string | null;
  onSelectTask: (taskId: string) => void;
  onSelectIssue: (issueNumber: number) => void;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
  onSetDropTarget: (target: BoardDropTarget) => void;
  onTaskDrop: (taskId: string, columnId: BoardColumnId, index?: number) => void;
  onDependencyDraftStart: (taskId: string, clientX: number, clientY: number) => void;
  onStartTask: (taskId: string) => void;
  onStartIssue: (issue: RepoIssueSummary) => void;
  onMarkReviewReady: (taskId: string) => void;
  onArchiveTask: (taskId: string, reason: 'completed' | 'discarded') => void;
  onRestoreTask: (taskId: string) => void;
  onRefreshIssues: () => void;
}

export interface DependencyOverlayProps {
  renderedDependencies: RenderedDependency[];
  renderedDraftDependency: { path: string; midpointX: number; midpointY: number } | null;
  dependencyLayout: DependencyLayout;
  onRemoveDependency: (dependencyId: string) => void;
}

export interface TaskWorkspaceProps {
  selectedTask: BoardTaskView | null;
  selectedIssue: RepoIssueSummary | null;
  selectedTaskStatus: StatusTone | null;
  editor: BoardEditorState | null;
  availableRuntimes: BoardSnapshot['availableRuntimes'];
  snapshot: BoardSnapshot | null;
  allTasks: BoardTaskView[];
  dependencyOptions: DependencyOption[];
  dependencyTargetId: string;
  startBusyTaskId: string | null;
  issueStartBusyNumber: number | null;
  mutationBusy: string | null;
  reviewSnapshot: WorkflowReviewSnapshot | null;
  reviewLoading: boolean;
  reviewError: string | null;
  onSetEditor: (editor: BoardEditorState | null) => void;
  onSetDependencyTargetId: (id: string) => void;
  onStartTask: (taskId: string) => void;
  onStartIssue: (issue: RepoIssueSummary) => void;
  onMarkReviewReady: (taskId: string) => void;
  onArchiveTask: (taskId: string, reason: 'completed' | 'discarded') => void;
  onRestoreTask: (taskId: string) => void;
  onSaveTask: () => void;
  onAddDependency: () => void;
  onRemoveDependency: (dependencyId: string) => void;
  onRefreshReview: () => void;
}

export interface BoardToolbarProps {
  repoName: string | null | undefined;
  repoPath: string | null | undefined;
  snapshot: BoardSnapshot | null;
  refreshing: boolean;
  backlogIssueCount: number;
  onRefresh: () => void;
}
