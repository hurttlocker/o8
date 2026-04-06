'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BoardColumnId, BoardSnapshot, BoardTaskView } from '@/lib/board/types';
import type { WorkflowReviewSnapshot } from '@/lib/fleet/types';
import type {
  BoardComposerState,
  BoardDropTarget,
  BoardEditorState,
  DependencyDraft,
  DependencyLayout,
  DependencyOption,
  RenderedDependency,
  RepoIssueSummary,
  StatusTone,
} from './types';
import { DEFAULT_COMPOSER_STATE } from './constants';
import {
  buildDependencyPath,
  buildEditorState,
  normalizeColumnId,
  normalizeNumeric,
  statusTone,
} from './utils';

export function useTaskBoard(repoPath?: string | null) {
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
  const selectedTaskStatus = useMemo<StatusTone | null>(
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
    const anchors: Record<string, import('./types').TaskAnchor> = {};

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

  const dependencyOptions = useMemo<DependencyOption[]>(() => {
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

  return {
    snapshot,
    loading,
    refreshing,
    error,
    selectedTaskId,
    selectedTask,
    selectedIssueNumber,
    selectedIssue,
    selectedTaskStatus,
    composerOpen,
    composer,
    editor,
    mutationBusy,
    startBusyTaskId,
    dragTaskId,
    dropTarget,
    dependencyDraft,
    dependencyLayout,
    dependencyTargetId,
    reviewSnapshot,
    reviewLoading,
    reviewError,
    issues,
    issuesLoading,
    issuesError,
    issueStartBusyNumber,
    boardSurfaceRef,
    allTasks,
    backlogIssues,
    availableRuntimes,
    defaultBaseBranch,
    dependencyOptions,
    renderedDependencies,
    renderedDraftDependency,
    setComposerOpen,
    setComposer,
    setEditor,
    setDragTaskId,
    setDropTarget,
    setDependencyDraft,
    setDependencyTargetId,
    selectTask,
    selectIssue,
    readSnapshot,
    readIssues,
    refreshReview,
    handleCreateTask,
    handleStartTask,
    handleStartIssue,
    handleSaveTask,
    handleMarkReviewReady,
    handleArchiveTask,
    handleRestoreTask,
    handleTaskDrop,
    handleAddDependency,
    handleRemoveDependency,
  };
}
