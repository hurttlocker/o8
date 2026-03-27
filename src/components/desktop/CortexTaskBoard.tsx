'use client';

import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ChevronRight,
  ExternalLink,
  GitBranch,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { WorkflowReviewPanel } from '@/components/workflow-review-panel';
import type { BoardColumnId, BoardSnapshot, BoardTaskView } from '@/lib/board/types';
import type { WorkflowReviewSnapshot } from '@/lib/fleet/types';

const COLUMN_ORDER: BoardColumnId[] = ['backlog', 'in_progress', 'review', 'trash'];
const CARD_TRANSITION = 'all 180ms cubic-bezier(0.32, 0.72, 0, 1)';

type BoardComposerState = {
  title: string;
  prompt: string;
  preferredRuntime: 'codex' | 'claude-code';
  baseBranch: string;
  issueId: string;
  prId: string;
  startInPlanMode: boolean;
};

type BoardEditorState = BoardComposerState;

const DEFAULT_COMPOSER_STATE: BoardComposerState = {
  title: '',
  prompt: '',
  preferredRuntime: 'codex',
  baseBranch: 'main',
  issueId: '',
  prId: '',
  startInPlanMode: false,
};

type DependencyDraft = {
  sourceTaskId: string;
  targetTaskId: string | null;
  pointerClientX: number;
  pointerClientY: number;
};

type TaskAnchor = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerX: number;
  centerY: number;
  columnId: BoardColumnId | null;
};

type DependencyLayout = {
  width: number;
  height: number;
  anchors: Record<string, TaskAnchor>;
};

type RenderedDependency = {
  id: string;
  path: string;
  midpointX: number;
  midpointY: number;
};

type BoardDropTarget = {
  columnId: BoardColumnId;
  index: number;
} | null;

type RepoIssueSummary = {
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

function relativeAge(timestamp?: string | null) {
  if (!timestamp) return 'just now';
  const delta = Math.max(0, Date.now() - new Date(timestamp).getTime());
  const minute = 60_000;
  const hour = 60 * minute;
  if (delta < minute) return 'just now';
  if (delta < hour) return `${Math.max(1, Math.round(delta / minute))}m ago`;
  return `${Math.max(1, Math.round(delta / hour))}h ago`;
}

function compactPath(value?: string | null) {
  if (!value) return null;
  return value.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

function normalizeColumnId(value?: string | null): BoardColumnId | null {
  if (value === 'backlog' || value === 'in_progress' || value === 'review' || value === 'trash') {
    return value;
  }
  return null;
}

function cubicPoint(
  t: number,
  p0x: number,
  p0y: number,
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  p3x: number,
  p3y: number,
) {
  const inverse = 1 - t;
  const inverseSquared = inverse * inverse;
  const inverseCubed = inverseSquared * inverse;
  const tSquared = t * t;
  const tCubed = tSquared * t;
  return {
    x: inverseCubed * p0x + 3 * inverseSquared * t * p1x + 3 * inverse * tSquared * p2x + tCubed * p3x,
    y: inverseCubed * p0y + 3 * inverseSquared * t * p1y + 3 * inverse * tSquared * p2y + tCubed * p3y,
  };
}

function buildDependencyPath(source: TaskAnchor, target: TaskAnchor | { centerX: number; centerY: number }, draft = false) {
  const sourceOrder = source.columnId ? COLUMN_ORDER.indexOf(source.columnId) : -1;
  const targetOrder = 'columnId' in target && target.columnId ? COLUMN_ORDER.indexOf(target.columnId) : -1;
  const startOnLeft = !draft && sourceOrder > -1 && targetOrder > -1 && sourceOrder > targetOrder;
  const endOnLeft = draft
    ? target.centerX >= source.centerX
    : sourceOrder > -1 && targetOrder > -1 && sourceOrder < targetOrder;

  const startX = startOnLeft ? source.left - 6 : source.right + 6;
  const startY = source.centerY;
  const endX = endOnLeft ? target.centerX - 6 : target.centerX + (draft ? 0 : 6);
  const endY = target.centerY;
  const horizontalDistance = Math.abs(endX - startX);
  const controlOffset = Math.max(44, Math.min(160, horizontalDistance * 0.42));
  const control1X = startOnLeft ? startX - controlOffset : startX + controlOffset;
  const control2X = endOnLeft ? endX - controlOffset : endX + controlOffset;
  const midpoint = cubicPoint(0.5, startX, startY, control1X, startY, control2X, endY, endX, endY);

  return {
    path: `M ${startX} ${startY} C ${control1X} ${startY}, ${control2X} ${endY}, ${endX} ${endY}`,
    midpointX: midpoint.x,
    midpointY: midpoint.y,
  };
}

function statusTone(task: BoardTaskView) {
  if (task.reviewReady) {
    return {
      label: 'Review ready',
      color: '#15803d',
      background: 'rgba(34,197,94,0.12)',
      border: 'rgba(34,197,94,0.18)',
    };
  }
  if (task.columnId === 'in_progress') {
    return {
      label: task.runtimeSession?.status === 'reviewing' ? 'Reviewing' : 'Running',
      color: '#1d4ed8',
      background: 'rgba(37,99,235,0.12)',
      border: 'rgba(37,99,235,0.18)',
    };
  }
  if (task.blocked) {
    return {
      label: 'Blocked',
      color: '#b45309',
      background: 'rgba(249,115,22,0.12)',
      border: 'rgba(249,115,22,0.18)',
    };
  }
  if (task.columnId === 'trash') {
    return {
      label: task.archiveReason === 'discarded' ? 'Discarded' : 'Archived',
      color: task.archiveReason === 'discarded' ? '#b91c1c' : '#475569',
      background: task.archiveReason === 'discarded' ? 'rgba(239,68,68,0.1)' : 'rgba(148,163,184,0.14)',
      border: task.archiveReason === 'discarded' ? 'rgba(239,68,68,0.16)' : 'rgba(148,163,184,0.18)',
    };
  }
  return {
    label: task.startable ? 'Ready' : 'Queued',
    color: '#475569',
    background: 'rgba(148,163,184,0.14)',
    border: 'rgba(148,163,184,0.18)',
  };
}

function taskStatusClass(task: BoardTaskView) {
  if (task.columnId === 'trash') {
    return task.archiveReason === 'discarded' ? 'status-critical' : 'status-stable';
  }
  if (task.reviewReady || task.columnId === 'review') {
    return 'status-reviewing';
  }
  if (task.columnId === 'in_progress') {
    return 'status-running';
  }
  if (task.blocked) {
    return 'status-warning';
  }
  return task.startable ? 'status-healthy' : 'status-stable';
}

function runtimeStatusClass(status?: string | null) {
  switch (status) {
    case 'running':
      return 'status-running';
    case 'reviewing':
      return 'status-reviewing';
    case 'blocked':
    case 'failed':
      return 'status-critical';
    case 'waiting':
      return 'status-warning';
    case 'idle':
    default:
      return 'status-stable';
  }
}

function taskReviewLabel(task: BoardTaskView) {
  if (task.columnId === 'trash') {
    return task.archiveReason === 'discarded' ? 'Discarded' : 'Archived';
  }
  if (task.columnId === 'review') return 'Needs operator decision';
  if (task.reviewReady) return 'Ready to review';
  if (task.columnId === 'in_progress') return 'Awaiting review signal';
  return task.blocked ? 'Blocked by dependency' : 'Waiting to start';
}

function archiveReasonLabel(reason?: 'completed' | 'discarded' | null) {
  if (reason === 'discarded') return 'Discarded';
  if (reason === 'completed') return 'Archived';
  return 'Active';
}

function taskWorkspaceSummary(task: BoardTaskView) {
  if (task.columnId === 'trash') {
    return task.archiveReason === 'discarded'
      ? 'Removed from the active lane but preserved as board history.'
      : 'Archived from review with a preserved runtime snapshot, not a live binding.';
  }
  if (task.columnId === 'review') {
    return 'Use the review surface to inspect the live worktree and decide whether to archive or continue.';
  }
  if (task.columnId === 'in_progress') {
    return 'This task is tied to a live runtime and worktree. Review can only happen from a real review-ready signal.';
  }
  return 'Backlog stays honest: dependencies gate start, and starting launches a real runtime with a real worktree.';
}

function normalizeNumeric(value: string) {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildEditorState(task: BoardTaskView): BoardEditorState {
  return {
    title: task.title,
    prompt: task.prompt,
    preferredRuntime: task.preferredRuntime,
    baseBranch: task.baseBranch,
    issueId: task.bindings.issueId ? String(task.bindings.issueId) : '',
    prId: task.bindings.prId ? String(task.bindings.prId) : '',
    startInPlanMode: task.automation.startInPlanMode,
  };
}

export function CortexTaskBoard({
  repoPath,
  repoName,
}: {
  repoPath?: string | null;
  repoName?: string | null;
}) {
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedIssueNumber, setSelectedIssueNumber] = useState<number | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composer, setComposer] = useState<BoardComposerState>(DEFAULT_COMPOSER_STATE);
  const [editor, setEditor] = useState<BoardEditorState | null>(null);
  const [mutationBusy, setMutationBusy] = useState<string | null>(null);
  const [startBusyTaskId, setStartBusyTaskId] = useState<string | null>(null);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<BoardDropTarget>(null);
  const [dependencyDraft, setDependencyDraft] = useState<DependencyDraft | null>(null);
  const [dependencyLayout, setDependencyLayout] = useState<DependencyLayout>({ width: 0, height: 0, anchors: {} });
  const [dependencyTargetId, setDependencyTargetId] = useState<string>('');
  const [reviewSnapshot, setReviewSnapshot] = useState<WorkflowReviewSnapshot | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [issues, setIssues] = useState<RepoIssueSummary[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [issueStartBusyNumber, setIssueStartBusyNumber] = useState<number | null>(null);
  const boardSurfaceRef = useRef<HTMLDivElement | null>(null);
  const lastEditorTaskIdRef = useRef<string | null>(null);

  const allTasks = useMemo(
    () => snapshot?.columns.flatMap((column) => column.tasks) ?? [],
    [snapshot],
  );

  const selectedTask = useMemo(
    () => allTasks.find((task) => task.id === selectedTaskId) ?? null,
    [allTasks, selectedTaskId],
  );
  const linkedIssueNumbers = useMemo(
    () => new Set(allTasks.map((task) => task.bindings.issueId).filter((value): value is number => typeof value === 'number')),
    [allTasks],
  );
  const backlogIssues = useMemo(
    () => issues.filter((issue) => !linkedIssueNumbers.has(issue.number)),
    [issues, linkedIssueNumbers],
  );
  const selectedIssue = useMemo(
    () => backlogIssues.find((issue) => issue.number === selectedIssueNumber) ?? null,
    [backlogIssues, selectedIssueNumber],
  );
  const selectedTaskStatus = useMemo(
    () => (selectedTask ? statusTone(selectedTask) : null),
    [selectedTask],
  );

  const availableRuntimes = snapshot?.availableRuntimes ?? [];
  const defaultBaseBranch = snapshot?.state.defaultBaseBranch ?? 'main';

  const selectTask = useCallback((taskId: string) => {
    setSelectedIssueNumber(null);
    setSelectedTaskId(taskId);
  }, []);

  const selectIssue = useCallback((issueNumber: number) => {
    setSelectedTaskId(null);
    setSelectedIssueNumber(issueNumber);
  }, []);

  const canLinkTasks = useCallback((fromTaskId: string, toTaskId: string) => {
    if (fromTaskId === toTaskId) return false;
    const fromTask = allTasks.find((task) => task.id === fromTaskId) ?? null;
    const toTask = allTasks.find((task) => task.id === toTaskId) ?? null;
    if (!fromTask || !toTask) return false;
    if (fromTask.columnId === 'trash' || toTask.columnId === 'trash') return false;
    if (fromTask.columnId !== 'backlog' && toTask.columnId !== 'backlog') return false;
    const pairExists = snapshot?.state.dependencies.some((dependency) => (
      (dependency.fromTaskId === fromTaskId && dependency.toTaskId === toTaskId)
      || (dependency.fromTaskId === toTaskId && dependency.toTaskId === fromTaskId)
    ));
    return !pairExists;
  }, [allTasks, snapshot?.state.dependencies]);

  const readSnapshot = useCallback(async (options?: { silent?: boolean }) => {
    if (!repoPath) {
      setSnapshot(null);
      setLoading(false);
      return;
    }

    if (options?.silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const response = await fetch(`/api/board?repo=${encodeURIComponent(repoPath)}`, {
        cache: 'no-store',
      });
      const payload = await response.json() as BoardSnapshot | { error?: string };
      if (!response.ok || !('state' in payload)) {
        throw new Error(('error' in payload && payload.error) || 'Unable to load board state.');
      }
      setSnapshot(payload);
      setError(null);
      setComposer((current) => ({
        ...current,
        preferredRuntime: (payload.availableRuntimes[0]?.id === 'claude-code' ? 'claude-code' : current.preferredRuntime),
        baseBranch: current.baseBranch || payload.state.defaultBaseBranch,
      }));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to load board state.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [repoPath]);

  const readIssues = useCallback(async (options?: { silent?: boolean }) => {
    const repoSlug = snapshot?.state.repoSlug?.trim();
    if (!repoSlug) {
      setIssues([]);
      setIssuesError(null);
      return;
    }

    if (!options?.silent) {
      setIssuesLoading(true);
    }

    try {
      const response = await fetch(`/api/panel/issues?repo=${encodeURIComponent(repoSlug)}`, {
        cache: 'no-store',
      });
      const payload = await response.json() as { issues?: RepoIssueSummary[]; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to load repository issues.');
      }
      setIssues(Array.isArray(payload.issues) ? payload.issues : []);
      setIssuesError(typeof payload.error === 'string' ? payload.error : null);
    } catch (nextError) {
      setIssues([]);
      setIssuesError(nextError instanceof Error ? nextError.message : 'Unable to load repository issues.');
    } finally {
      setIssuesLoading(false);
    }
  }, [snapshot?.state.repoSlug]);

  useEffect(() => {
    void readSnapshot();
    if (!repoPath) return;
    const intervalId = window.setInterval(() => {
      void readSnapshot({ silent: true });
    }, 15_000);
    return () => window.clearInterval(intervalId);
  }, [readSnapshot, repoPath]);

  useEffect(() => {
    void readIssues();
  }, [readIssues]);

  useEffect(() => {
    if (!snapshot) return;
    if (selectedTaskId && allTasks.some((task) => task.id === selectedTaskId)) {
      return;
    }
    if (selectedIssueNumber && backlogIssues.some((issue) => issue.number === selectedIssueNumber)) {
      return;
    }
    if (backlogIssues[0]) {
      setSelectedTaskId(null);
      setSelectedIssueNumber(backlogIssues[0].number);
      return;
    }
    setSelectedIssueNumber(null);
    setSelectedTaskId(allTasks[0]?.id ?? null);
  }, [allTasks, backlogIssues, selectedIssueNumber, selectedTaskId, snapshot]);

  useEffect(() => {
    if (!selectedTask) {
      lastEditorTaskIdRef.current = null;
      setEditor(null);
      setDependencyTargetId('');
      return;
    }
    if (lastEditorTaskIdRef.current === selectedTask.id) {
      return;
    }
    lastEditorTaskIdRef.current = selectedTask.id;
    setEditor(buildEditorState(selectedTask));
    setDependencyTargetId('');
  }, [selectedTask, selectedTaskId]);

  const refreshReview = useCallback(async () => {
    if (!repoPath || !selectedTask) {
      setReviewSnapshot(null);
      setReviewError(null);
      return;
    }

    const workspace = selectedTask.bindings.worktreePath || repoPath;
    if (!workspace) {
      setReviewSnapshot(null);
      setReviewError(null);
      return;
    }

    setReviewLoading(true);
    try {
      const response = await fetch(`/api/review/workspace?workspace=${encodeURIComponent(workspace)}`, {
        cache: 'no-store',
      });
      const payload = await response.json() as WorkflowReviewSnapshot | { error?: string };
      if (!response.ok || !('repoPath' in payload)) {
        throw new Error(('error' in payload && payload.error) || 'Unable to load review surface.');
      }
      setReviewSnapshot(payload);
      setReviewError(null);
    } catch (nextError) {
      setReviewSnapshot(null);
      setReviewError(nextError instanceof Error ? nextError.message : 'Unable to load review surface.');
    } finally {
      setReviewLoading(false);
    }
  }, [repoPath, selectedTask]);

  useEffect(() => {
    void refreshReview();
  }, [refreshReview]);

  const measureDependencyLayout = useCallback(() => {
    const container = boardSurfaceRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const anchors: Record<string, TaskAnchor> = {};

    for (const element of Array.from(container.querySelectorAll<HTMLElement>('[data-task-id]'))) {
      const taskId = element.dataset.taskId;
      if (!taskId) continue;
      const rect = element.getBoundingClientRect();
      anchors[taskId] = {
        left: rect.left - containerRect.left,
        right: rect.right - containerRect.left,
        top: rect.top - containerRect.top,
        bottom: rect.bottom - containerRect.top,
        centerX: rect.left - containerRect.left + rect.width / 2,
        centerY: rect.top - containerRect.top + rect.height / 2,
        columnId: normalizeColumnId(element.dataset.columnId),
      };
    }

    setDependencyLayout((current) => {
      const sameSize = current.width === containerRect.width && current.height === containerRect.height;
      const currentKeys = Object.keys(current.anchors);
      const nextKeys = Object.keys(anchors);
      const sameKeys = currentKeys.length === nextKeys.length && currentKeys.every((key) => nextKeys.includes(key));
      const sameAnchors = sameKeys && nextKeys.every((key) => {
        const currentAnchor = current.anchors[key];
        const nextAnchor = anchors[key];
        return Boolean(currentAnchor)
          && currentAnchor.left === nextAnchor.left
          && currentAnchor.right === nextAnchor.right
          && currentAnchor.top === nextAnchor.top
          && currentAnchor.bottom === nextAnchor.bottom
          && currentAnchor.centerX === nextAnchor.centerX
          && currentAnchor.centerY === nextAnchor.centerY
          && currentAnchor.columnId === nextAnchor.columnId;
      });

      if (sameSize && sameAnchors) {
        return current;
      }

      return {
        width: containerRect.width,
        height: containerRect.height,
        anchors,
      };
    });
  }, []);

  useLayoutEffect(() => {
    measureDependencyLayout();
  }, [measureDependencyLayout, snapshot, selectedTaskId, dependencyDraft]);

  useEffect(() => {
    const handleResize = () => measureDependencyLayout();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [measureDependencyLayout]);

  const mutateBoard = useCallback(async (mutation: Record<string, unknown>) => {
    if (!repoPath || !snapshot) return null;
    setMutationBusy(typeof mutation.type === 'string' ? mutation.type : 'mutation');
    try {
      const response = await fetch('/api/board', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repo: repoPath,
          expectedRevision: snapshot.state.revision,
          mutation,
        }),
      });
      const payload = await response.json() as BoardSnapshot | { error?: string };
      if (!response.ok || !('state' in payload)) {
        throw new Error(('error' in payload && payload.error) || 'Unable to update board state.');
      }
      setSnapshot(payload);
      setError(null);
      return payload;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to update board state.');
      await readSnapshot({ silent: true });
      return null;
    } finally {
      setMutationBusy(null);
    }
  }, [readSnapshot, repoPath, snapshot]);

  useEffect(() => {
    if (!dependencyDraft) {
      return;
    }

    const getTaskIdFromPoint = (clientX: number, clientY: number) => {
      const elements = document.elementsFromPoint(clientX, clientY);
      for (const element of elements) {
        const card = element.closest('[data-task-id]');
        if (card instanceof HTMLElement) {
          return card.dataset.taskId ?? null;
        }
      }
      return null;
    };

    const handleMouseMove = (event: MouseEvent) => {
      const maybeTargetId = getTaskIdFromPoint(event.clientX, event.clientY);
      setDependencyDraft((current) => current ? {
        ...current,
        pointerClientX: event.clientX,
        pointerClientY: event.clientY,
        targetTaskId: maybeTargetId && canLinkTasks(current.sourceTaskId, maybeTargetId) ? maybeTargetId : null,
      } : current);
    };

    const handleMouseUp = () => {
      setDependencyDraft((current) => {
        if (current?.targetTaskId && canLinkTasks(current.sourceTaskId, current.targetTaskId)) {
          void mutateBoard({
            type: 'add_dependency',
            fromTaskId: current.sourceTaskId,
            toTaskId: current.targetTaskId,
          });
        }
        return null;
      });
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('blur', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('blur', handleMouseUp);
    };
  }, [canLinkTasks, dependencyDraft, mutateBoard]);

  const handleCreateTask = useCallback(async () => {
    const title = composer.title.trim();
    if (!title) {
      setError('Task title is required.');
      return;
    }

    const payload = await mutateBoard({
      type: 'create_task',
      columnId: 'backlog',
      task: {
        title,
        prompt: composer.prompt.trim() || title,
        preferredRuntime: composer.preferredRuntime,
        baseBranch: composer.baseBranch.trim() || defaultBaseBranch,
        issueId: normalizeNumeric(composer.issueId),
        prId: normalizeNumeric(composer.prId),
        startInPlanMode: composer.startInPlanMode,
      },
    });
    if (!payload) return;

    const created = payload.columns.find((column) => column.id === 'backlog')?.tasks[0] ?? null;
    if (created?.id) {
      selectTask(created.id);
    }
    setComposer({
      ...DEFAULT_COMPOSER_STATE,
      preferredRuntime: composer.preferredRuntime,
      baseBranch: payload.state.defaultBaseBranch,
    });
    setComposerOpen(false);
  }, [composer, defaultBaseBranch, mutateBoard, selectTask]);

  const handleStartTask = useCallback(async (taskId: string) => {
    if (!repoPath) return;
    setStartBusyTaskId(taskId);
    try {
      const response = await fetch(`/api/board/tasks/${encodeURIComponent(taskId)}/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repo: repoPath,
        }),
      });
      const payload = await response.json() as { snapshot?: BoardSnapshot; error?: string };
      if (!response.ok || !payload.snapshot) {
        throw new Error(payload.error || 'Unable to start task.');
      }
      setSnapshot(payload.snapshot);
      setError(null);
      selectTask(taskId);
      void readIssues({ silent: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to start task.');
      await readSnapshot({ silent: true });
    } finally {
      setStartBusyTaskId(null);
    }
  }, [readIssues, readSnapshot, repoPath, selectTask]);

  const handleStartIssue = useCallback(async (issue: RepoIssueSummary) => {
    setIssueStartBusyNumber(issue.number);
    try {
      const createdSnapshot = await mutateBoard({
        type: 'create_task',
        columnId: 'backlog',
        task: {
          title: issue.title,
          prompt: issue.body?.trim() || issue.title,
          preferredRuntime: composer.preferredRuntime,
          baseBranch: defaultBaseBranch,
          issueId: issue.number,
          startInPlanMode: false,
        },
      });
      if (!createdSnapshot) return;

      const createdTask = createdSnapshot.columns
        .flatMap((column) => column.tasks)
        .find((task) => task.bindings.issueId === issue.number)
        ?? null;
      if (!createdTask) {
        throw new Error('Issue task was not created on the board.');
      }

      selectTask(createdTask.id);
      await handleStartTask(createdTask.id);
      await readIssues({ silent: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to start issue task.');
    } finally {
      setIssueStartBusyNumber(null);
    }
  }, [composer.preferredRuntime, defaultBaseBranch, handleStartTask, mutateBoard, readIssues, selectTask]);

  const handleSaveTask = useCallback(async () => {
    if (!selectedTask || !editor) return;
    const payload = await mutateBoard({
      type: 'update_task',
      taskId: selectedTask.id,
      patch: {
        title: editor.title,
        prompt: editor.prompt,
        preferredRuntime: editor.preferredRuntime,
        baseBranch: editor.baseBranch,
        issueId: normalizeNumeric(editor.issueId),
        prId: normalizeNumeric(editor.prId),
        startInPlanMode: editor.startInPlanMode,
      },
    });
    if (!payload) return;
    const nextTask = payload.columns.flatMap((column) => column.tasks).find((task) => task.id === selectedTask.id) ?? null;
    if (nextTask) {
      setEditor(buildEditorState(nextTask));
    }
  }, [editor, mutateBoard, selectedTask]);

  const handleReorderTask = useCallback(async (taskId: string, columnId: BoardColumnId, toIndex: number) => {
    await mutateBoard({
      type: 'reorder_task',
      taskId,
      columnId,
      toIndex,
    });
  }, [mutateBoard]);

  const handleMarkReviewReady = useCallback(async (taskId: string) => {
    await mutateBoard({
      type: 'mark_review_ready',
      taskId,
    });
  }, [mutateBoard]);

  const handleArchiveTask = useCallback(async (taskId: string, reason: 'completed' | 'discarded') => {
    await mutateBoard({
      type: 'archive_task',
      taskId,
      reason,
    });
  }, [mutateBoard]);

  const handleRestoreTask = useCallback(async (taskId: string, toIndex = 0) => {
    await mutateBoard({
      type: 'restore_task',
      taskId,
      toIndex,
    });
  }, [mutateBoard]);

  const handleTaskDrop = useCallback(async (
    taskId: string,
    toColumnId: BoardColumnId,
    toIndex?: number,
  ) => {
    const task = allTasks.find((entry) => entry.id === taskId) ?? null;
    if (!task) return;

    if (task.columnId === toColumnId) {
      const column = snapshot?.columns.find((entry) => entry.id === toColumnId) ?? null;
      const currentIndex = column?.tasks.findIndex((entry) => entry.id === taskId) ?? -1;
      if (!column || currentIndex < 0) return;
      const requestedIndex = typeof toIndex === 'number' ? toIndex : column.tasks.length;
      await handleReorderTask(taskId, toColumnId, requestedIndex);
      return;
    }

    if (task.columnId === 'backlog' && toColumnId === 'in_progress') {
      if (!task.startable) {
        setError('This task is still blocked by dependencies and cannot be started yet.');
        return;
      }
      await handleStartTask(taskId);
      return;
    }

    if (task.columnId === 'in_progress' && toColumnId === 'review') {
      await handleMarkReviewReady(taskId);
      return;
    }

    if (task.columnId === 'review' && toColumnId === 'trash') {
      await handleArchiveTask(taskId, 'completed');
      return;
    }

    if (task.columnId === 'trash' && toColumnId === 'backlog') {
      await handleRestoreTask(taskId, typeof toIndex === 'number' ? toIndex : 0);
      return;
    }

    setError(
      'Invalid board transition. Start backlog tasks, mark in-progress tasks review-ready, archive review tasks, or restore archived tasks to backlog.',
    );
  }, [
    allTasks,
    handleArchiveTask,
    handleMarkReviewReady,
    handleReorderTask,
    handleRestoreTask,
    handleStartTask,
    snapshot,
  ]);

  const handleAddDependency = useCallback(async () => {
    if (!selectedTask || !dependencyTargetId) return;
    await mutateBoard({
      type: 'add_dependency',
      fromTaskId: selectedTask.id,
      toTaskId: dependencyTargetId,
    });
    setDependencyTargetId('');
  }, [dependencyTargetId, mutateBoard, selectedTask]);

  const handleRemoveDependency = useCallback(async (dependencyId: string) => {
    await mutateBoard({
      type: 'remove_dependency',
      dependencyId,
    });
  }, [mutateBoard]);

  const dependencyOptions = useMemo(() => {
    if (!selectedTask) return [];
    return allTasks
      .filter((task) => task.id !== selectedTask.id && task.columnId !== 'trash')
      .filter((task) => (
        selectedTask.columnId === 'backlog'
          ? true
          : task.columnId === 'backlog'
      ))
      .map((task) => ({
        id: task.id,
        label: `${task.title} · ${task.columnId.replace('_', ' ')}`,
      }));
  }, [allTasks, selectedTask]);

  const renderedDependencies = useMemo<RenderedDependency[]>(() => {
    if (!snapshot) return [];
    return snapshot.state.dependencies
      .map((dependency) => {
        const source = dependencyLayout.anchors[dependency.fromTaskId];
        const target = dependencyLayout.anchors[dependency.toTaskId];
        if (!source || !target) return null;
        return {
          id: dependency.id,
          ...buildDependencyPath(source, target),
        };
      })
      .filter((dependency): dependency is RenderedDependency => Boolean(dependency));
  }, [dependencyLayout.anchors, snapshot]);

  const renderedDraftDependency = useMemo(() => {
    if (!dependencyDraft) return null;
    const source = dependencyLayout.anchors[dependencyDraft.sourceTaskId];
    const container = boardSurfaceRef.current;
    if (!source || !container) return null;
    const rect = container.getBoundingClientRect();
    return buildDependencyPath(source, {
      centerX: dependencyDraft.pointerClientX - rect.left,
      centerY: dependencyDraft.pointerClientY - rect.top,
    }, true);
  }, [dependencyDraft, dependencyLayout.anchors]);

  if (!repoPath) {
    return (
      <div style={emptyStateStyle}>
        <AlertCircle size={16} />
        <span>Select a repo in Cortex before opening the operator board.</span>
      </div>
    );
  }

  if (loading && !snapshot) {
    return (
      <div style={emptyStateStyle}>
        <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} />
        <span>Loading Cortex board…</span>
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      gap: 14,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 14,
        flexWrap: 'wrap',
      }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
            Cortex Board
          </div>
          <div style={{ marginTop: 4, fontSize: 18, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--text)' }}>
            {repoName || compactPath(repoPath) || 'Current repository'}
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
            Repo issues feed the backlog. Starting an issue creates a real Cortex task, worktree, and review lane.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <MetricChip label="Startable" value={snapshot?.startableTaskIds.length ?? 0} tone="blue" />
          <MetricChip label="Running" value={snapshot?.columns.find((column) => column.id === 'in_progress')?.tasks.length ?? 0} tone="orange" />
          <MetricChip label="Review" value={snapshot?.columns.find((column) => column.id === 'review')?.tasks.length ?? 0} tone="green" />
          <button
            type="button"
            onClick={() => void readSnapshot({ silent: true })}
            style={toolbarButtonStyle(Boolean(refreshing))}
          >
            <RefreshCw size={14} style={refreshing ? { animation: 'spin 1s linear infinite' } : undefined} />
            Refresh
          </button>
        </div>
      </div>

      {error ? (
        <div style={errorBannerStyle}>
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      ) : null}

      <div style={{
        display: 'grid',
        gridTemplateColumns: composerOpen ? 'minmax(280px, 320px) minmax(0, 1fr)' : 'minmax(0, 1fr)',
        gap: 14,
        minHeight: 0,
        flex: 1,
      }}>
        {composerOpen ? (
          <div style={sidePanelStyle}>
            <div style={panelHeaderStyle}>
              <div>
                <div style={panelEyebrowStyle}>Task Composer</div>
                <strong style={panelTitleStyle}>Create Board Task</strong>
              </div>
              <button
                type="button"
                onClick={() => setComposerOpen(false)}
                style={closeButtonStyle}
              >
                ×
              </button>
            </div>

            <BoardForm
              value={composer}
              availableRuntimes={availableRuntimes}
              onChange={setComposer}
            />

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button
                type="button"
                onClick={() => void handleCreateTask()}
                disabled={mutationBusy === 'create_task'}
                className="button-primary board-task-action-button"
              >
                <Plus size={14} />
                Create task
              </button>
              <button
                type="button"
                onClick={() => setComposerOpen(false)}
                style={secondaryButtonStyle}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.45fr) minmax(420px, 1.12fr)',
          gap: 14,
          minHeight: 0,
        }}>
          <div
            ref={boardSurfaceRef}
            style={{
              position: 'relative',
              display: 'grid',
              gridTemplateColumns: 'repeat(4, minmax(220px, 1fr))',
              gap: 12,
              minHeight: 0,
            }}
          >
            <svg
              aria-hidden
              style={{
                position: 'absolute',
                inset: 0,
                width: dependencyLayout.width || '100%',
                height: dependencyLayout.height || '100%',
                overflow: 'visible',
                pointerEvents: 'none',
                zIndex: 1,
              }}
            >
              {renderedDependencies.map((dependency) => (
                <g key={dependency.id}>
                  <path
                    d={dependency.path}
                    fill="none"
                    stroke="rgba(37,99,235,0.18)"
                    strokeWidth="7"
                    strokeLinecap="round"
                  />
                  <path
                    d={dependency.path}
                    fill="none"
                    stroke="rgba(37,99,235,0.68)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeDasharray="6 6"
                  />
                  <foreignObject
                    x={dependency.midpointX - 14}
                    y={dependency.midpointY - 14}
                    width={28}
                    height={28}
                    style={{ pointerEvents: 'auto' }}
                  >
                    <button
                      type="button"
                      onClick={() => void handleRemoveDependency(dependency.id)}
                      style={dependencyDeleteButtonStyle}
                    >
                      <X size={11} />
                    </button>
                  </foreignObject>
                </g>
              ))}

              {renderedDraftDependency ? (
                <>
                  <path
                    d={renderedDraftDependency.path}
                    fill="none"
                    stroke="rgba(37,99,235,0.15)"
                    strokeWidth="6"
                    strokeLinecap="round"
                  />
                  <path
                    d={renderedDraftDependency.path}
                    fill="none"
                    stroke="rgba(37,99,235,0.82)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeDasharray="7 5"
                  />
                </>
              ) : null}
            </svg>

            {snapshot?.columns.map((column) => (
              <div
                key={column.id}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (dragTaskId) {
                    setDropTarget({
                      columnId: column.id,
                      index: column.tasks.length,
                    });
                  }
                }}
                onDragLeave={() => {
                  if (dropTarget?.columnId === column.id && dropTarget.index === column.tasks.length) {
                    setDropTarget(null);
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const taskId = event.dataTransfer.getData('text/plain') || dragTaskId;
                  if (taskId) {
                    void handleTaskDrop(taskId, column.id, column.tasks.length);
                  }
                  setDragTaskId(null);
                  setDropTarget(null);
                }}
                style={{
                  ...columnStyle,
                  position: 'relative',
                  zIndex: 2,
                  borderColor: dropTarget?.columnId === column.id ? 'rgba(59,130,246,0.4)' : 'var(--border)',
                  boxShadow: dropTarget?.columnId === column.id
                    ? '0 0 0 1px rgba(59,130,246,0.22), var(--shadow)'
                    : 'var(--shadow)',
                }}
              >
                <div style={panelHeaderStyle}>
                  <div>
                    <div style={panelEyebrowStyle}>{column.id.replace('_', ' ')}</div>
                    <strong style={panelTitleStyle}>{column.title}</strong>
                  </div>
                  <span style={columnCountStyle}>{column.tasks.length + (column.id === 'backlog' ? backlogIssues.length : 0)}</span>
                </div>

                {column.id === 'backlog' ? (
                  <div style={columnIssueHeaderStyle}>
                    <span>{issuesLoading ? 'Syncing repo issues…' : `${backlogIssues.length} open issues ready`}</span>
                    <button
                      type="button"
                      onClick={() => void readIssues()}
                      style={ghostButtonStyle}
                    >
                      <RefreshCw size={12} style={issuesLoading ? { animation: 'spin 1s linear infinite' } : undefined} />
                      Refresh issues
                    </button>
                  </div>
                ) : null}

                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  overflowY: 'auto',
                  paddingRight: 2,
                  minHeight: 0,
                  flex: 1,
                }}>
                  {column.id === 'backlog' ? backlogIssues.map((issue) => {
                    const isActiveIssue = selectedIssue?.number === issue.number;
                    return (
                      <button
                        key={`issue-${issue.number}`}
                        type="button"
                        onClick={() => selectIssue(issue.number)}
                        className={`workflow-file-item board-issue-card${isActiveIssue ? ' board-issue-card-active' : ''}`}
                        style={{ textAlign: 'left' }}
                      >
                        <div className="row space-between compact-row">
                          <strong>{`#${issue.number} ${issue.title}`}</strong>
                          <span className="status-pill status-stable">{relativeAge(issue.updatedAt)}</span>
                        </div>
                        <p className="muted">
                          {issue.body?.trim()
                            ? issue.body.trim().replace(/\s+/g, ' ').slice(0, 180)
                            : 'No issue body yet.'}
                        </p>
                        <div className="board-task-chip-row">
                          <BoardPill>{issue.comments} comments</BoardPill>
                          {issue.labels.slice(0, 2).map((label) => (
                            <BoardPill key={`${issue.number}-${label.name}`}>{label.name}</BoardPill>
                          ))}
                        </div>
                        <div className="board-task-action-row">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleStartIssue(issue);
                            }}
                            disabled={issueStartBusyNumber === issue.number}
                            className="button-primary board-task-action-button"
                          >
                            {issueStartBusyNumber === issue.number ? <RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={13} />}
                            Start issue
                          </button>
                          <a
                            href={issue.url}
                            target="_blank"
                            rel="noreferrer"
                            className="board-task-link"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <ExternalLink size={13} />
                            Open issue
                          </a>
                        </div>
                      </button>
                    );
                  }) : null}

                  {column.tasks.map((task, taskIndex) => {
                    const status = statusTone(task);
                    const isDropTarget = dropTarget?.columnId === column.id && dropTarget.index === taskIndex;
                    return (
                      <div
                        key={task.id}
                        draggable
                        data-task-id={task.id}
                        data-column-id={column.id}
                        role="button"
                        tabIndex={0}
                        onDragStart={(event) => {
                          event.dataTransfer.setData('text/plain', task.id);
                          event.dataTransfer.effectAllowed = 'move';
                          setDragTaskId(task.id);
                        }}
                        onDragEnd={() => {
                          setDragTaskId(null);
                          setDropTarget(null);
                        }}
                        onDragOver={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          if (dragTaskId) {
                            setDropTarget({
                              columnId: column.id,
                              index: taskIndex,
                            });
                          }
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const taskId = event.dataTransfer.getData('text/plain') || dragTaskId;
                          if (taskId) {
                            void handleTaskDrop(taskId, column.id, taskIndex);
                          }
                          setDragTaskId(null);
                          setDropTarget(null);
                        }}
                        onClick={() => selectTask(task.id)}
                        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            selectTask(task.id);
                          }
                        }}
                        style={{
                          ...taskCardStyle,
                          borderColor: dependencyDraft?.sourceTaskId === task.id
                            ? 'rgba(59,130,246,0.5)'
                            : dependencyDraft?.targetTaskId === task.id
                              ? 'rgba(34,197,94,0.4)'
                              : selectedTaskId === task.id
                                ? 'rgba(59,130,246,0.34)'
                                : 'var(--border)',
                          boxShadow: dependencyDraft?.sourceTaskId === task.id
                            ? '0 16px 38px rgba(59,130,246,0.18)'
                            : dependencyDraft?.targetTaskId === task.id
                              ? '0 16px 38px rgba(34,197,94,0.14)'
                              : isDropTarget
                                ? '0 0 0 1px rgba(59,130,246,0.22), 0 16px 38px rgba(59,130,246,0.12)'
                              : selectedTaskId === task.id
                                ? '0 14px 36px rgba(59,130,246,0.14)'
                                : '0 10px 28px rgba(15,23,42,0.08)',
                          transform: dragTaskId === task.id ? 'scale(0.985)' : 'translateY(0)',
                        }}
                      >
                        {task.columnId !== 'trash' ? (
                          <button
                            type="button"
                            aria-label="Pull dependency link"
                            onMouseDown={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setDependencyDraft({
                                sourceTaskId: task.id,
                                targetTaskId: null,
                                pointerClientX: event.clientX,
                                pointerClientY: event.clientY,
                              });
                            }}
                            style={{
                              ...dependencyHandleStyle,
                              background: dependencyDraft?.sourceTaskId === task.id
                                ? 'rgba(59,130,246,0.92)'
                                : dependencyDraft?.targetTaskId === task.id
                                  ? 'rgba(22,163,74,0.92)'
                                  : 'var(--panel-strong)',
                              borderColor: dependencyDraft?.sourceTaskId === task.id
                                ? 'rgba(29,78,216,0.94)'
                                : dependencyDraft?.targetTaskId === task.id
                                  ? 'rgba(22,163,74,0.88)'
                                  : 'var(--border)',
                              color: dependencyDraft?.sourceTaskId === task.id || dependencyDraft?.targetTaskId === task.id
                                ? '#ffffff'
                                : 'var(--blue)',
                            }}
                          >
                            <span style={dependencyHandleDotsStyle} />
                          </button>
                        ) : null}

                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                          <div style={{ minWidth: 0, textAlign: 'left' }}>
                            <div style={{ fontSize: 13, fontWeight: 800, lineHeight: 1.35, color: 'var(--text)', letterSpacing: '-0.02em' }}>
                              {task.title}
                            </div>
                            <div style={{
                              marginTop: 5,
                              fontSize: 11,
                              color: 'var(--text-secondary)',
                              lineHeight: 1.45,
                              display: '-webkit-box',
                              WebkitLineClamp: 3,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                            }}>
                              {task.prompt}
                            </div>
                          </div>
                          <span style={{
                            padding: '4px 8px',
                            borderRadius: 999,
                            background: status.background,
                            border: `1px solid ${status.border}`,
                            color: status.color,
                            fontSize: 10,
                            fontWeight: 700,
                            whiteSpace: 'nowrap',
                          }}>
                            {status.label}
                          </span>
                        </div>

                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                          <BoardPill>{task.preferredRuntime === 'claude-code' ? 'Claude Code' : 'Codex'}</BoardPill>
                          <BoardPill>{task.baseBranch}</BoardPill>
                          {task.bindings.issueId ? <BoardPill>Issue #{task.bindings.issueId}</BoardPill> : null}
                          {task.bindings.prId ? <BoardPill>PR #{task.bindings.prId}</BoardPill> : null}
                        </div>

                        {(task.blockedByTitles.length > 0 || task.runtimeSession || task.worktree) ? (
                          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6, textAlign: 'left' }}>
                            {task.blockedByTitles.length > 0 ? (
                              <div style={{ fontSize: 10.5, color: 'var(--yellow)', lineHeight: 1.4 }}>
                                Blocked by {task.blockedByTitles.slice(0, 2).join(' • ')}
                              </div>
                            ) : null}
                            {task.runtimeSession ? (
                              <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                                {task.runtimeSession.name} · {task.runtimeSession.status}
                              </div>
                            ) : null}
                            {task.worktree ? (
                              <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: 1.4, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                                {task.worktree.branch}
                              </div>
                            ) : null}
                          </div>
                        ) : null}

                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                          marginTop: 12,
                        }}>
                          <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                            Updated {relativeAge(task.updatedAt)}
                          </div>

                          <div style={{ display: 'flex', gap: 6 }}>
                            {task.columnId === 'backlog' && task.startable ? (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleStartTask(task.id);
                                }}
                                disabled={startBusyTaskId === task.id}
                                style={miniActionButtonStyle('primary')}
                              >
                                {startBusyTaskId === task.id ? <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={12} />}
                                Start
                              </button>
                            ) : null}
                            {task.columnId === 'in_progress' && task.reviewReady ? (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleMarkReviewReady(task.id);
                                }}
                                style={miniActionButtonStyle('secondary')}
                              >
                                <ChevronRight size={12} />
                                Review
                              </button>
                            ) : null}
                            {task.columnId === 'review' ? (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleArchiveTask(task.id, 'completed');
                                }}
                                style={miniActionButtonStyle('secondary')}
                              >
                                <Trash2 size={12} />
                                Archive
                              </button>
                            ) : null}
                            {task.columnId === 'trash' ? (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleRestoreTask(task.id);
                                }}
                                style={miniActionButtonStyle('secondary')}
                              >
                                <RotateCcw size={12} />
                                Restore
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {column.tasks.length === 0 && (column.id !== 'backlog' || backlogIssues.length === 0) ? (
                    <div style={columnEmptyStyle}>
                      {column.id === 'backlog'
                        ? issuesError
                          ? `Issue queue unavailable: ${issuesError}`
                          : 'Open repo issues appear here. Start one to create a real Cortex task and worktree.'
                        : column.id === 'in_progress'
                          ? 'Started tasks land here with runtime and worktree bindings.'
                          : column.id === 'review'
                            ? 'Only real review-ready work can land here.'
                            : 'Archive keeps operator history with disposition, not silent deletion.'}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          <aside className="surface-card board-task-workspace-shell">
            <div className="section-head">
              <div>
                <div className="eyebrow">Task workspace</div>
                <h2>{selectedTask?.title ?? 'Select a task'}</h2>
              </div>
              {selectedTask ? (
                <span className={`status-pill ${taskStatusClass(selectedTask)}`}>
                  {selectedTaskStatus?.label ?? selectedTask.columnId.replace('_', ' ')}
                </span>
              ) : null}
            </div>

            {!selectedTask && !selectedIssue ? (
              <div className="board-task-empty">
                <Plus size={16} />
                <span>Select a card to open its task desk.</span>
              </div>
            ) : selectedIssue && !selectedTask ? (
              <div className="board-task-workspace">
                <div className="inset-card inspector-block tool-shell board-task-strip">
                  <div className="row space-between compact-row operator-header-row">
                    <div>
                      <span>Repo issue</span>
                      <strong>{`#${selectedIssue.number} ${selectedIssue.title}`}</strong>
                    </div>
                    <span className="status-pill status-stable">{relativeAge(selectedIssue.updatedAt)}</span>
                  </div>

                  <p className="muted operator-note">
                    Backlog is now repo-issue first. Start the issue to create a truthful board task with a real runtime and worktree.
                  </p>

                  <div className="board-task-chip-row">
                    <BoardPill>{selectedIssue.state}</BoardPill>
                    <BoardPill>{selectedIssue.comments} comments</BoardPill>
                    {selectedIssue.labels.slice(0, 4).map((label) => (
                      <BoardPill key={`selected-issue-${selectedIssue.number}-${label.name}`}>{label.name}</BoardPill>
                    ))}
                  </div>

                  <div className="board-task-action-row">
                    <button
                      type="button"
                      onClick={() => void handleStartIssue(selectedIssue)}
                      disabled={issueStartBusyNumber === selectedIssue.number}
                      className="button-primary board-task-action-button"
                    >
                      {issueStartBusyNumber === selectedIssue.number ? <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={14} />}
                      Start issue
                    </button>
                    <a
                      href={selectedIssue.url}
                      target="_blank"
                      rel="noreferrer"
                      className="board-task-link"
                    >
                      <ExternalLink size={14} />
                      Open on GitHub
                    </a>
                  </div>
                </div>

                <div className="board-task-grid">
                  <div className="board-task-primary">
                    <div className="surface-card board-task-review-empty">
                      <div className="section-head">
                        <div>
                          <div className="eyebrow">Issue context</div>
                          <h2>Implementation brief</h2>
                        </div>
                      </div>
                      <div className="workflow-file-list">
                        <div className="workflow-file-item">
                          <div className="row space-between compact-row">
                            <strong>Description</strong>
                            <span className="muted">{selectedIssue.author?.login ? `Opened by ${selectedIssue.author.login}` : 'GitHub issue'}</span>
                          </div>
                          <p className="muted">
                            {selectedIssue.body?.trim() || 'No issue body was provided.'}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="board-task-secondary">
                    <div className="inset-card inspector-block tool-shell">
                      <div className="row space-between compact-row operator-header-row">
                        <div>
                          <span>Queue state</span>
                          <strong>Repo issue waiting in backlog</strong>
                        </div>
                        <span className="status-pill status-stable">not started</span>
                      </div>
                      <p className="muted operator-note">
                        This issue is not a live task yet. Starting it creates the board task, binds the issue number, and launches the real runtime path.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            ) : selectedTask && editor ? (
              <div className="board-task-workspace">
                <div className="inset-card inspector-block tool-shell board-task-strip">
                  <div className="row space-between compact-row operator-header-row">
                    <div>
                      <span>Task desk</span>
                      <strong>{selectedTask.title}</strong>
                    </div>
                    <div className="board-task-status-group">
                      <span className={`status-pill ${taskStatusClass(selectedTask)}`}>
                        {selectedTaskStatus?.label ?? selectedTask.columnId.replace('_', ' ')}
                      </span>
                      <span className={`status-pill ${runtimeStatusClass(selectedTask.runtimeSession?.status)}`}>
                        {selectedTask.runtimeSession?.status ?? (selectedTask.archivedRuntime ? 'archived lane' : 'not started')}
                      </span>
                    </div>
                  </div>

                  <p className="muted operator-note">{taskWorkspaceSummary(selectedTask)}</p>

                  <div className="board-task-chip-row">
                    <BoardPill>{selectedTask.columnId.replace('_', ' ')}</BoardPill>
                    <BoardPill>{selectedTask.preferredRuntime === 'claude-code' ? 'Claude Code' : 'Codex'}</BoardPill>
                    <BoardPill>{selectedTask.baseBranch}</BoardPill>
                    {selectedTask.bindings.issueId ? <BoardPill>Issue #{selectedTask.bindings.issueId}</BoardPill> : null}
                    {selectedTask.bindings.prId ? <BoardPill>PR #{selectedTask.bindings.prId}</BoardPill> : null}
                    {selectedTask.columnId === 'trash' ? <BoardPill>{archiveReasonLabel(selectedTask.archiveReason)}</BoardPill> : null}
                    {selectedTask.worktree ? <BoardPill>{selectedTask.worktree.branch}</BoardPill> : null}
                    {selectedTask.archivedRuntime?.worktreeId ? <BoardPill>Archived lane</BoardPill> : null}
                  </div>

                  <div className="board-task-action-row">
                    {selectedTask.columnId === 'backlog' && selectedTask.startable ? (
                      <button
                        type="button"
                        onClick={() => void handleStartTask(selectedTask.id)}
                        disabled={startBusyTaskId === selectedTask.id}
                        className="button-primary board-task-action-button"
                      >
                        {startBusyTaskId === selectedTask.id ? <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={14} />}
                        Start task
                      </button>
                    ) : null}

                    {selectedTask.columnId === 'in_progress' ? (
                      <button
                        type="button"
                        onClick={() => void handleMarkReviewReady(selectedTask.id)}
                        disabled={!selectedTask.reviewReady || mutationBusy === 'mark_review_ready'}
                        className="board-task-action-button"
                      >
                        <ChevronRight size={14} />
                        {selectedTask.reviewReady ? 'Mark review-ready' : 'Awaiting review signal'}
                      </button>
                    ) : null}

                    {selectedTask.columnId === 'review' ? (
                      <button
                        type="button"
                        onClick={() => void handleArchiveTask(selectedTask.id, 'completed')}
                        disabled={mutationBusy === 'archive_task'}
                        className="board-task-action-button"
                      >
                        <Trash2 size={14} />
                        Archive to trash
                      </button>
                    ) : null}

                    {(selectedTask.columnId === 'backlog' || selectedTask.columnId === 'in_progress') ? (
                      <button
                        type="button"
                        onClick={() => void handleArchiveTask(selectedTask.id, 'discarded')}
                        disabled={mutationBusy === 'archive_task'}
                        className="board-task-action-button board-task-action-button-danger"
                      >
                        <Trash2 size={14} />
                        Discard
                      </button>
                    ) : null}

                    {selectedTask.columnId === 'trash' ? (
                      <button
                        type="button"
                        onClick={() => void handleRestoreTask(selectedTask.id)}
                        disabled={mutationBusy === 'restore_task'}
                        className="board-task-action-button"
                      >
                        <RotateCcw size={14} />
                        Restore to backlog
                      </button>
                    ) : null}

                    {selectedTask.bindings.prId && snapshot?.state.repoSlug ? (
                      <a
                        href={`https://github.com/${snapshot.state.repoSlug}/pull/${selectedTask.bindings.prId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="board-task-link"
                      >
                        <ExternalLink size={14} />
                        Open PR #{selectedTask.bindings.prId}
                      </a>
                    ) : null}
                  </div>
                </div>

                <div className="board-task-grid">
                  <div className="board-task-primary">
                    {reviewSnapshot || reviewError ? (
                      <WorkflowReviewPanel
                        controlled
                        initialSnapshot={reviewSnapshot}
                        error={reviewError}
                        onRefresh={refreshReview}
                      />
                    ) : (
                      <div className="surface-card board-task-review-empty">
                        <div className="section-head">
                          <div>
                            <div className="eyebrow">Review surface</div>
                            <h2>Waiting for a real task-local worktree</h2>
                          </div>
                          <button
                            type="button"
                            onClick={() => void refreshReview()}
                            className="board-task-action-button"
                          >
                            <RefreshCw size={14} style={reviewLoading ? { animation: 'spin 1s linear infinite' } : undefined} />
                            Refresh
                          </button>
                        </div>
                        <div className="board-task-empty">
                          <span>Start the task into a real worktree or refresh once the runtime reports review context.</span>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="board-task-secondary">
                    <div className="inset-card inspector-block tool-shell">
                      <div className="row space-between compact-row operator-header-row">
                        <div>
                          <span>Runtime lane</span>
                          <strong>Bindings, worktree, and resume truth</strong>
                        </div>
                        <span className={`status-pill ${selectedTask.runtimeSession ? runtimeStatusClass(selectedTask.runtimeSession.status) : selectedTask.archivedRuntime ? 'status-stable' : 'status-warning'}`}>
                          {selectedTask.runtimeSession ? selectedTask.runtimeSession.status : selectedTask.archivedRuntime ? 'history only' : 'unbound'}
                        </span>
                      </div>

                      <div className="operator-state-grid board-task-secondary-grid">
                        <div className="operator-state-card">
                          <span>Board state</span>
                          <strong>{selectedTask.columnId.replace('_', ' ')}</strong>
                          <p className="muted">{taskReviewLabel(selectedTask)}</p>
                        </div>
                        <div className="operator-state-card">
                          <span>Live runtime</span>
                          <strong>{selectedTask.runtimeSession?.name ?? 'Not attached'}</strong>
                          <p className="muted mono">{selectedTask.bindings.runtimeSurfaceId ?? 'No runtime surface id'}</p>
                        </div>
                        <div className="operator-state-card">
                          <span>Session / worktree</span>
                          <strong>{selectedTask.bindings.sessionId ?? selectedTask.bindings.worktreeId ?? 'No active binding'}</strong>
                          <p className="muted mono">
                            {compactPath(selectedTask.bindings.worktreePath ?? selectedTask.worktree?.path) ?? 'No worktree path bound'}
                          </p>
                        </div>
                        <div className="operator-state-card">
                          <span>Review / PR</span>
                          <strong>{selectedTask.bindings.prId ? `PR #${selectedTask.bindings.prId}` : 'No PR linked'}</strong>
                          <p className="muted">
                            {selectedTask.bindings.issueId
                              ? `Issue #${selectedTask.bindings.issueId}`
                              : selectedTask.reviewReady || selectedTask.columnId === 'review'
                                ? 'Task is on the review path'
                                : 'Review stays attached to the task worktree'}
                          </p>
                        </div>
                        <div className="operator-state-card">
                          <span>Restore model</span>
                          <strong>{selectedTask.archivedRuntime ? 'Fresh restart only' : 'Direct start allowed'}</strong>
                          <p className="muted">
                            Archive converts live task bindings into history so restore never relaunches on top of stale execution.
                          </p>
                        </div>
                      </div>

                      <div className="workflow-file-list board-task-binding-list">
                        {selectedTask.worktree ? (
                          <div className="workflow-file-item">
                            <div className="row space-between compact-row">
                              <strong>Active worktree</strong>
                              <span className="status-pill status-running">{selectedTask.worktree.status}</span>
                            </div>
                            <p className="muted mono">
                              {selectedTask.worktree.branch}
                              {' • '}
                              {compactPath(selectedTask.worktree.path) ?? selectedTask.worktree.path}
                            </p>
                          </div>
                        ) : null}

                        {selectedTask.archivedRuntime ? (
                          <div className="workflow-file-item">
                            <div className="row space-between compact-row">
                              <strong>Archived runtime snapshot</strong>
                              <span className="status-pill status-stable">
                                {selectedTask.archivedRuntime.archivedAt ? relativeAge(selectedTask.archivedRuntime.archivedAt) : 'history'}
                              </span>
                            </div>
                            <p className="muted mono">
                              {(selectedTask.archivedRuntime.runtime === 'claude-code' ? 'claude-code' : selectedTask.archivedRuntime.runtime === 'codex' ? 'codex' : 'runtime')}
                              {' • '}
                              {selectedTask.archivedRuntime.runtimeSurfaceId ?? selectedTask.archivedRuntime.sessionId ?? 'surface unavailable'}
                              {' • '}
                              {compactPath(selectedTask.archivedRuntime.worktreePath) ?? 'no archived worktree path'}
                            </p>
                          </div>
                        ) : null}

                        {!selectedTask.runtimeSession && !selectedTask.worktree && !selectedTask.archivedRuntime ? (
                          <div className="board-task-empty board-task-empty-compact">
                            <span>No task-local runtime or worktree is attached yet.</span>
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div className="inset-card inspector-block tool-shell">
                      <div className="row space-between compact-row operator-header-row">
                        <div>
                          <span>Dependencies</span>
                          <strong>Graph context survives restore</strong>
                        </div>
                        <span className="status-pill status-stable">
                          {selectedTask.blockedByTaskIds.length + selectedTask.dependentTaskIds.length} links
                        </span>
                      </div>
                      <p className="muted operator-note">
                        Links stay persisted even while a task is archived. Only active backlog blockers can prevent a new start.
                      </p>

                      <div className="board-task-linker">
                        <select
                          value={dependencyTargetId}
                          onChange={(event) => setDependencyTargetId(event.target.value)}
                          className="board-task-select"
                        >
                          <option value="">Select task to link…</option>
                          {dependencyOptions.map((option) => (
                            <option key={option.id} value={option.id}>{option.label}</option>
                          ))}
                        </select>
                        <button type="button" onClick={() => void handleAddDependency()} className="board-task-action-button">
                          <Plus size={14} />
                          Link
                        </button>
                      </div>

                      <div className="board-task-dependency-list">
                        {selectedTask.blockedByTaskIds.map((taskId) => {
                          const dependency = snapshot?.state.dependencies.find((item) => item.fromTaskId === selectedTask.id && item.toTaskId === taskId);
                          const label = allTasks.find((task) => task.id === taskId)?.title ?? taskId;
                          return (
                            <DependencyRow
                              key={dependency?.id ?? `blocked-${taskId}`}
                              label={`Depends on ${label}`}
                              onRemove={dependency ? () => void handleRemoveDependency(dependency.id) : undefined}
                            />
                          );
                        })}
                        {selectedTask.dependentTaskIds.map((taskId) => {
                          const dependency = snapshot?.state.dependencies.find((item) => item.toTaskId === selectedTask.id && item.fromTaskId === taskId);
                          const label = allTasks.find((task) => task.id === taskId)?.title ?? taskId;
                          return (
                            <DependencyRow
                              key={dependency?.id ?? `dependent-${taskId}`}
                              label={`${label} depends on this`}
                              onRemove={dependency ? () => void handleRemoveDependency(dependency.id) : undefined}
                            />
                          );
                        })}
                        {selectedTask.blockedByTaskIds.length === 0 && selectedTask.dependentTaskIds.length === 0 ? (
                          <div className="board-task-empty board-task-empty-compact">
                            <span>No dependency links yet.</span>
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div className="inset-card inspector-block tool-shell">
                      <div className="row space-between compact-row operator-header-row">
                        <div>
                          <span>Task brief</span>
                          <strong>Prompt, issue linkage, and metadata</strong>
                        </div>
                        <span className="status-pill status-stable">{selectedTask.automation.startInPlanMode ? 'plan first' : 'direct start'}</span>
                      </div>
                      <div className="workflow-file-list">
                        <div className="workflow-file-item">
                          <div className="row space-between compact-row">
                            <strong>Prompt</strong>
                            <span className="muted">{selectedTask.updatedAt ? `Updated ${relativeAge(selectedTask.updatedAt)}` : 'current'}</span>
                          </div>
                          <p className="muted">{selectedTask.prompt}</p>
                        </div>
                      </div>
                    </div>

                    <details className="inset-card inspector-block tool-shell board-task-editor-shell">
                      <summary className="board-task-editor-summary">
                        <div>
                          <span>Edit task</span>
                          <strong>Secondary metadata editor</strong>
                        </div>
                        <ChevronRight size={14} />
                      </summary>
                      <div className="board-task-editor-body">
                        <p className="muted operator-note">
                          Editing stays secondary to the task-local review and runtime desk. Change the brief here, then save it back into the board model.
                        </p>
                        <BoardForm
                          value={editor}
                          availableRuntimes={availableRuntimes}
                          onChange={setEditor}
                        />
                        <div className="board-task-action-row">
                          <button
                            type="button"
                            onClick={() => void handleSaveTask()}
                            disabled={mutationBusy === 'update_task'}
                            className="button-primary board-task-action-button"
                          >
                            Save task
                          </button>
                        </div>
                      </div>
                    </details>
                  </div>
                </div>
              </div>
            ) : (
              <div className="board-task-empty">
                <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} />
                <span>Preparing the selected workspace…</span>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

function BoardForm({
  value,
  availableRuntimes,
  onChange,
}: {
  value: BoardComposerState;
  availableRuntimes: BoardSnapshot['availableRuntimes'];
  onChange: (value: BoardComposerState) => void;
}) {
  return (
    <div className="board-task-form">
      <LabeledField label="Title">
        <input
          value={value.title}
          onChange={(event) => onChange({ ...value, title: event.target.value })}
          placeholder="Summarize the task"
          className="board-task-input"
        />
      </LabeledField>

      <LabeledField label="Prompt">
        <textarea
          value={value.prompt}
          onChange={(event) => onChange({ ...value, prompt: event.target.value })}
          placeholder="Operator prompt or implementation brief"
          className="board-task-textarea operator-textarea"
        />
      </LabeledField>

      <div className="board-task-field-grid">
        <LabeledField label="Runtime">
          <select
            value={value.preferredRuntime}
            onChange={(event) => onChange({ ...value, preferredRuntime: event.target.value === 'claude-code' ? 'claude-code' : 'codex' })}
            className="board-task-select"
          >
            {availableRuntimes.map((runtime) => (
              <option key={runtime.id} value={runtime.id}>
                {runtime.label}
              </option>
            ))}
          </select>
        </LabeledField>

        <LabeledField label="Base Branch">
          <div style={{ position: 'relative' }}>
            <GitBranch size={13} style={{ position: 'absolute', left: 10, top: 11, color: '#64748b' }} />
            <input
              value={value.baseBranch}
              onChange={(event) => onChange({ ...value, baseBranch: event.target.value })}
              placeholder="main"
              className="board-task-input"
              style={{ paddingLeft: 32 }}
            />
          </div>
        </LabeledField>
      </div>

      <div className="board-task-field-grid">
        <LabeledField label="Issue">
          <input
            value={value.issueId}
            onChange={(event) => onChange({ ...value, issueId: event.target.value })}
            placeholder="#123"
            className="board-task-input"
          />
        </LabeledField>

        <LabeledField label="PR">
          <input
            value={value.prId}
            onChange={(event) => onChange({ ...value, prId: event.target.value })}
            placeholder="#456"
            className="board-task-input"
          />
        </LabeledField>
      </div>

      <label className="board-task-checkbox">
        <input
          type="checkbox"
          checked={value.startInPlanMode}
          onChange={(event) => onChange({ ...value, startInPlanMode: event.target.checked })}
        />
        <span>Start in plan mode first</span>
      </label>
    </div>
  );
}

function LabeledField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="board-task-field">
      <span>
        {label}
      </span>
      {children}
    </label>
  );
}

function DependencyRow({
  label,
  onRemove,
}: {
  label: string;
  onRemove?: () => void;
}) {
  return (
    <div className="workflow-file-item board-task-dependency-row">
      <span>{label}</span>
      {onRemove ? (
        <button type="button" onClick={onRemove} className="board-task-inline-button board-task-inline-button-danger">
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}

function MetricChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'blue' | 'orange' | 'green';
}) {
  const palette = tone === 'orange'
    ? { color: '#b45309', background: 'rgba(249,115,22,0.12)', border: 'rgba(249,115,22,0.18)' }
    : tone === 'green'
      ? { color: '#15803d', background: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.18)' }
      : { color: '#1d4ed8', background: 'rgba(37,99,235,0.12)', border: 'rgba(37,99,235,0.18)' };
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 12px',
      borderRadius: 999,
      background: palette.background,
      border: `1px solid ${palette.border}`,
      color: palette.color,
      fontSize: 11,
      fontWeight: 700,
    }}>
      <span>{label}</span>
      <span style={{ fontSize: 12 }}>{value}</span>
    </div>
  );
}

function BoardPill({ children }: { children: ReactNode }) {
  return (
    <span className="board-task-pill">
      {children}
    </span>
  );
}

const sidePanelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  padding: 14,
  borderRadius: 22,
  border: '1px solid var(--border)',
  background: 'var(--panel)',
  backdropFilter: 'blur(18px)',
  WebkitBackdropFilter: 'blur(18px)',
  boxShadow: 'var(--shadow)',
  overflow: 'hidden',
};

const columnStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  padding: 12,
  borderRadius: 20,
  border: '1px solid var(--border)',
  background: 'var(--panel)',
  backdropFilter: 'blur(18px)',
  WebkitBackdropFilter: 'blur(18px)',
};

const taskCardStyle: CSSProperties = {
  width: '100%',
  position: 'relative',
  borderRadius: 18,
  border: '1px solid var(--border)',
  background: 'var(--panel)',
  padding: 14,
  cursor: 'pointer',
  textAlign: 'left',
  transition: CARD_TRANSITION,
};

const panelHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  marginBottom: 12,
};

const panelEyebrowStyle: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: '#64748b',
};

const panelTitleStyle: CSSProperties = {
  display: 'block',
  marginTop: 4,
  fontSize: 15,
  fontWeight: 800,
  letterSpacing: '-0.02em',
  color: 'var(--text)',
};

const columnCountStyle: CSSProperties = {
  minWidth: 26,
  height: 26,
  borderRadius: 999,
  border: '1px solid var(--border)',
  background: 'var(--panel-strong)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 9px',
  fontSize: 11,
  fontWeight: 800,
  color: 'var(--text-secondary)',
};

const columnIssueHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  marginBottom: 12,
  fontSize: 11,
  color: 'var(--text-secondary)',
  fontWeight: 600,
};

const ghostButtonStyle: CSSProperties = {
  height: 28,
  borderRadius: 999,
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-secondary)',
  padding: '0 10px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  fontWeight: 700,
};

const columnEmptyStyle: CSSProperties = {
  padding: '14px 12px',
  borderRadius: 14,
  border: '1px dashed var(--border)',
  background: 'rgba(255,255,255,0.06)',
  fontSize: 11.5,
  lineHeight: 1.5,
  color: 'var(--text-secondary)',
};

const secondaryButtonStyle: CSSProperties = {
  height: 38,
  borderRadius: 14,
  border: '1px solid var(--border)',
  background: 'var(--panel-strong)',
  backdropFilter: 'blur(16px)',
  WebkitBackdropFilter: 'blur(16px)',
  color: 'var(--text)',
  padding: '0 14px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12,
  fontWeight: 700,
};

function miniActionButtonStyle(kind: 'primary' | 'secondary' | 'danger'): CSSProperties {
  const secondary = kind === 'secondary';
  return {
    width: kind === 'primary' || secondary ? 'auto' : 28,
    height: 28,
    padding: kind === 'primary' || secondary ? '0 10px' : 0,
    borderRadius: 999,
    border:
      kind === 'primary'
        ? 'none'
        : secondary
          ? '1px solid var(--border)'
          : '1px solid rgba(248,113,113,0.22)',
    background:
      kind === 'primary'
        ? 'var(--blue)'
        : secondary
          ? 'var(--panel-strong)'
          : 'rgba(255,255,255,0.08)',
    color:
      kind === 'primary'
        ? '#ffffff'
        : secondary
          ? 'var(--text)'
          : '#b91c1c',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    fontSize: 11,
    fontWeight: 700,
  };
}

function toolbarButtonStyle(spinning: boolean): CSSProperties {
  return {
    height: 36,
    borderRadius: 14,
    border: '1px solid var(--border)',
    background: 'var(--panel-strong)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    color: 'var(--text)',
    padding: '0 12px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    fontWeight: 700,
    opacity: spinning ? 0.84 : 1,
  };
}

const emptyStateStyle: CSSProperties = {
  minHeight: 180,
  borderRadius: 20,
  border: '1px dashed var(--border)',
  background: 'var(--panel)',
  color: 'var(--text-secondary)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  fontSize: 12,
  fontWeight: 600,
};

const errorBannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 12px',
  borderRadius: 14,
  border: '1px solid rgba(239,68,68,0.22)',
  background: 'var(--red-soft)',
  color: 'var(--red)',
  fontSize: 12,
  fontWeight: 600,
};

const closeButtonStyle: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 999,
  border: '1px solid var(--border)',
  background: 'var(--panel-strong)',
  color: 'var(--text-secondary)',
  fontSize: 16,
  lineHeight: 1,
};

const dependencyHandleStyle: CSSProperties = {
  position: 'absolute',
  top: '50%',
  right: -8,
  transform: 'translateY(-50%)',
  width: 18,
  height: 40,
  borderRadius: 999,
  border: '1px solid var(--border)',
  boxShadow: '0 10px 24px rgba(15,23,42,0.12)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'grab',
  zIndex: 3,
};

const dependencyHandleDotsStyle: CSSProperties = {
  width: 4,
  height: 18,
  borderRadius: 999,
  background: 'currentColor',
  opacity: 0.82,
};

const dependencyDeleteButtonStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 999,
  border: '1px solid rgba(255,255,255,0.24)',
  background: 'rgba(255,255,255,0.68)',
  backdropFilter: 'blur(18px) saturate(1.3)',
  WebkitBackdropFilter: 'blur(18px) saturate(1.3)',
  color: '#1d4ed8',
  boxShadow: '0 10px 24px rgba(15,23,42,0.12)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
};
