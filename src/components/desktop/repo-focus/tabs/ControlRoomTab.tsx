'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SupervisorInboxItem } from '@/lib/supervisor/inbox';
import { AlertCircle, Archive, CheckCircle2, Clock, ShieldCheck } from '../../lucide-shims';
import {
  REPO_FOCUS_FONT,
} from '../utils';
import type {
  ControlRoomTabProps,
  GitHubIssueIntake,
  PanelIssuePayload,
  TaskAction,
  TaskActionMenuState,
  TaskMutationPayload,
  TaskPoolPayload,
  TaskPoolTask,
  SupervisorInboxPayload,
} from './control-room/types';
import {
  issueAge,
  issueKey,
  issueKind,
  isStaleTask,
  repoIssueParam,
  supervisorIncidentMatchesProject,
  taskMatchesProject,
} from './control-room/helpers';
import {
  CollapsedTaskSection,
  GitHubIntakeSection,
  NewTaskComposer,
  StatusMessage,
  SupervisorIncidentSection,
  TaskActionMenu,
  TaskSection,
  TaskStatusStrip,
} from './control-room/components';
import type { IdeWorkspaceSession } from '../types';

interface PendingDispatch {
  packetId: string | null;
  laneId: string | null;
  sessionKey: string | null;
  startedAt: number;
}

const PENDING_DISPATCH_TIMEOUT_MS = 30_000;

function findDispatchSessionKey(
  pending: PendingDispatch,
  sessions: IdeWorkspaceSession[],
): string | null {
  for (const session of sessions) {
    if (!session.sessionKey) continue;
    if (pending.sessionKey && session.sessionKey === pending.sessionKey) {
      return session.sessionKey;
    }
    if (pending.packetId && session.orchestrationPacket?.packetId === pending.packetId) {
      return session.sessionKey;
    }
  }
  return null;
}

export function ControlRoomTab({
  project,
  repos,
  selectedRepo,
  ideWorkspaceSessions = [],
  activeSessionKey,
  onSelectSession,
}: ControlRoomTabProps) {
  const [tasks, setTasks] = useState<TaskPoolTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issueIntake, setIssueIntake] = useState<GitHubIssueIntake[]>([]);
  const [issueLoading, setIssueLoading] = useState(false);
  const [issueRefreshing, setIssueRefreshing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [supervisorItems, setSupervisorItems] = useState<SupervisorInboxItem[]>([]);
  const [supervisorLoading, setSupervisorLoading] = useState(false);
  const [supervisorRefreshing, setSupervisorRefreshing] = useState(false);
  const [supervisorError, setSupervisorError] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [staleAttentionOpen, setStaleAttentionOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskSummary, setNewTaskSummary] = useState('');
  const [newTaskRepoPath, setNewTaskRepoPath] = useState(selectedRepo?.localPath ?? repos[0]?.localPath ?? '');
  const [newTaskIntent, setNewTaskIntent] = useState('heavy_worker');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionMenu, setActionMenu] = useState<TaskActionMenuState | null>(null);
  const [pendingDispatch, setPendingDispatch] = useState<PendingDispatch | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [isWide, setIsWide] = useState(false);

  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setIsWide(width >= 620);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  const intakeRepos = useMemo(() => (
    selectedRepo ? [selectedRepo] : repos
  ), [repos, selectedRepo]);

  const loadIssueIntake = useCallback(async (quiet = false, cancelled?: () => boolean) => {
    if (!quiet) setIssueLoading(true);
    setIssueRefreshing(true);
    try {
      const results = await Promise.all(intakeRepos.map(async (repo) => {
        const repoParam = repoIssueParam(repo);
        const response = await fetch(`/api/panel/issues?repo=${encodeURIComponent(repoParam)}`, { cache: 'no-store' }).catch(() => null);
        if (!response?.ok) {
          return {
            repo,
            repoFullName: repoParam,
            issues: [] as PanelIssuePayload[],
            error: response ? `HTTP ${response.status}` : 'network',
          };
        }
        const payload = await response.json().catch(() => ({})) as {
          repo?: string;
          issues?: PanelIssuePayload[];
          error?: string | null;
        };
        return {
          repo,
          repoFullName: payload.repo || repoParam,
          issues: Array.isArray(payload.issues) ? payload.issues : [],
          error: payload.error ?? null,
        };
      }));

      if (cancelled?.()) return;

      const next: GitHubIssueIntake[] = [];
      const errors: string[] = [];
      for (const result of results) {
        if (result.error) errors.push(`${result.repo.name}: ${result.error}`);
        for (const issue of result.issues) {
          const number = typeof issue.number === 'number' ? issue.number : Number(issue.number);
          const title = typeof issue.title === 'string' ? issue.title.trim() : '';
          if (!Number.isFinite(number) || !title) continue;
          const labels = Array.isArray(issue.labels)
            ? issue.labels.map((label) => {
              if (typeof label === 'string') return label;
              if (label && typeof label === 'object' && 'name' in label && typeof label.name === 'string') return label.name;
              return '';
            }).filter(Boolean)
            : [];
          const url = typeof issue.url === 'string' ? issue.url : '';
          const updatedAt = typeof issue.updatedAt === 'string' ? issue.updatedAt : null;
          const createdAt = typeof issue.createdAt === 'string' ? issue.createdAt : null;
          next.push({
            id: `${result.repoFullName}#${number}`,
            kind: issueKind(labels),
            repoId: result.repo.id,
            repoName: result.repo.name,
            repoPath: result.repo.localPath,
            repoFullName: result.repoFullName,
            number,
            title,
            body: typeof issue.body === 'string' ? issue.body.trim() : '',
            url,
            labels,
            comments: typeof issue.comments === 'number' ? issue.comments : Number(issue.comments) || 0,
            updatedAt,
            age: issueAge({ updatedAt, createdAt }),
          });
        }
      }
      next.sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
      setIssueIntake(next.slice(0, selectedRepo ? 10 : 18));
      setIssueError(errors.length > 0 ? errors.slice(0, 2).join(' - ') : null);
    } catch (err) {
      if (cancelled?.()) return;
      setIssueIntake([]);
      setIssueError(err instanceof Error ? err.message : 'Unable to load GitHub intake.');
    } finally {
      if (cancelled?.()) return;
      setIssueLoading(false);
      setIssueRefreshing(false);
    }
  }, [intakeRepos, selectedRepo]);

  const loadSupervisorIncidents = useCallback(async (quiet = false, cancelled?: () => boolean) => {
    if (!quiet) setSupervisorLoading(true);
    setSupervisorRefreshing(true);
    try {
      const response = await fetch('/api/panel/supervisor-inbox?scope=all', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json().catch(() => ({})) as SupervisorInboxPayload;
      if (cancelled?.()) return;
      setSupervisorItems(Array.isArray(payload.items) ? payload.items : []);
      setSupervisorError(null);
    } catch (err) {
      if (cancelled?.()) return;
      setSupervisorItems([]);
      setSupervisorError(err instanceof Error ? err.message : 'Unable to read supervisor incidents.');
    } finally {
      if (cancelled?.()) return;
      setSupervisorLoading(false);
      setSupervisorRefreshing(false);
    }
  }, []);

  const refresh = useCallback(async (quiet = false, cancelled?: () => boolean) => {
    if (!quiet) setLoading(true);
    setRefreshing(true);
    try {
      const response = await fetch('/api/tasks?includeBrief=false&includeDone=true', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as TaskPoolPayload;
      if (cancelled?.()) return;
      setTasks(payload.tasks ?? []);
      setError(null);
    } catch (err) {
      if (cancelled?.()) return;
      setTasks([]);
      setError(err instanceof Error ? err.message : 'Unable to read task pool.');
    } finally {
      if (cancelled?.()) return;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void refresh(false, () => cancelled);
    const timer = window.setInterval(() => {
      void refresh(true, () => cancelled);
    }, 7000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    void loadIssueIntake(false, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadIssueIntake]);

  useEffect(() => {
    let cancelled = false;
    void loadSupervisorIncidents(false, () => cancelled);
    const timer = window.setInterval(() => {
      void loadSupervisorIncidents(true, () => cancelled);
    }, 15000);
    const handleRefresh = () => {
      void loadSupervisorIncidents(true, () => cancelled);
    };
    window.addEventListener('o8:supervisor-inbox', handleRefresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('o8:supervisor-inbox', handleRefresh);
    };
  }, [loadSupervisorIncidents]);

  useEffect(() => {
    const fallbackRepo = selectedRepo?.localPath ?? repos[0]?.localPath ?? '';
    if (!fallbackRepo) return;
    if (selectedRepo || !newTaskRepoPath) setNewTaskRepoPath(fallbackRepo);
  }, [newTaskRepoPath, repos, selectedRepo]);

  useEffect(() => {
    if (!pendingDispatch) return;
    const matchKey = findDispatchSessionKey(pendingDispatch, ideWorkspaceSessions);
    if (matchKey) {
      onSelectSession?.(matchKey);
      setPendingDispatch(null);
      return;
    }
    const elapsed = Date.now() - pendingDispatch.startedAt;
    if (elapsed >= PENDING_DISPATCH_TIMEOUT_MS) {
      setPendingDispatch(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setPendingDispatch((current) => (current === pendingDispatch ? null : current));
    }, PENDING_DISPATCH_TIMEOUT_MS - elapsed);
    return () => {
      window.clearTimeout(timer);
    };
  }, [ideWorkspaceSessions, onSelectSession, pendingDispatch]);

  const mutateTask = useCallback(async (
    task: TaskPoolTask,
    action: TaskAction,
    body: Record<string, unknown> = {},
  ) => {
    const key = `${action}:${task.id}`;
    setBusyKey(key);
    setNotice(null);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actor: 'orchestrator',
          projectId: task.project?.id ?? project.id,
          repoPath: task.repoPath ?? selectedRepo?.localPath ?? null,
          ...body,
        }),
      });
      const payload = await response.json().catch(() => ({})) as Partial<TaskMutationPayload> & { error?: string };
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error ?? payload.note ?? `Task ${action} failed.`);
      }
      setNotice(payload.note ?? `Task ${action} complete.`);
      setActionMenu(null);
      await refresh(true);
      if (action === 'remove') {
        await loadIssueIntake(true);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : `Task ${action} failed.`);
    } finally {
      setBusyKey(null);
    }
  }, [loadIssueIntake, project.id, refresh, selectedRepo?.localPath]);

  const createControlTask = useCallback(async (dispatchAfterCreate = false) => {
    const title = newTaskTitle.trim();
    if (!title) {
      setNotice('Add a short task title first.');
      return;
    }
    setBusyKey(dispatchAfterCreate ? 'create-dispatch' : 'create');
    setNotice(null);
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          summary: newTaskSummary.trim() || null,
          projectId: project.id,
          repoPath: newTaskRepoPath || selectedRepo?.localPath || null,
          workerIntent: newTaskIntent,
        }),
      });
      const payload = await response.json().catch(() => ({})) as Partial<TaskMutationPayload> & { error?: string };
      if (!response.ok || payload.ok === false || !payload.taskId) {
        throw new Error(payload.error ?? payload.note ?? 'Task creation failed.');
      }
      let finalNote = payload.note ?? 'Task added to ready pool.';
      if (dispatchAfterCreate) {
        const dispatchResponse = await fetch(`/api/tasks/${encodeURIComponent(payload.taskId)}/dispatch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            actor: 'orchestrator',
            projectId: project.id,
            repoPath: newTaskRepoPath || selectedRepo?.localPath || null,
          }),
        });
        const dispatchPayload = await dispatchResponse.json().catch(() => ({})) as Partial<TaskMutationPayload> & { error?: string };
        if (!dispatchResponse.ok || dispatchPayload.ok === false) {
          throw new Error(dispatchPayload.error ?? dispatchPayload.note ?? 'Dispatch failed.');
        }
        finalNote = dispatchPayload.note ?? 'Task created and dispatched.';
      }
      setNewTaskTitle('');
      setNewTaskSummary('');
      setComposerOpen(false);
      setNotice(finalNote);
      await refresh(false);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Task creation failed.');
    } finally {
      setBusyKey(null);
    }
  }, [newTaskIntent, newTaskRepoPath, newTaskSummary, newTaskTitle, project.id, refresh, selectedRepo?.localPath]);

  const createIssueTask = useCallback(async (issue: GitHubIssueIntake, dispatchAfterCreate = false) => {
    const key = `${dispatchAfterCreate ? 'issue-dispatch' : 'issue-create'}:${issue.id}`;
    setBusyKey(key);
    setNotice(null);
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `#${issue.number} - ${issue.title}`,
          summary: [
            issue.body || issue.title,
            issue.url ? `Source: ${issue.url}` : null,
          ].filter(Boolean).join('\n\n'),
          projectId: project.id,
          repoPath: issue.repoPath,
          workerIntent: issue.kind === 'epic' ? 'orchestrator' : 'heavy_worker',
          requestedRuntime: 'codex',
          sourceIssue: {
            number: issue.number,
            body: issue.body,
            url: issue.url,
          },
        }),
      });
      const payload = await response.json().catch(() => ({})) as Partial<TaskMutationPayload> & { error?: string };
      if (!response.ok || payload.ok === false || !payload.taskId) {
        throw new Error(payload.error ?? payload.note ?? 'Issue intake failed.');
      }
      let finalNote = `${issue.kind === 'epic' ? 'Epic' : 'Issue'} #${issue.number} queued from ${issue.repoName}.`;
      if (dispatchAfterCreate) {
        const dispatchResponse = await fetch(`/api/tasks/${encodeURIComponent(payload.taskId)}/dispatch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            actor: 'orchestrator',
            projectId: project.id,
            repoPath: issue.repoPath,
            message: `Dispatch GitHub ${issue.kind} #${issue.number} from ${issue.repoFullName}.`,
          }),
        });
        const dispatchPayload = await dispatchResponse.json().catch(() => ({})) as Partial<TaskMutationPayload> & { error?: string };
        if (!dispatchResponse.ok || dispatchPayload.ok === false) {
          throw new Error(dispatchPayload.error ?? dispatchPayload.note ?? 'Issue dispatch failed.');
        }
        finalNote = dispatchPayload.note ?? `${issue.kind === 'epic' ? 'Epic' : 'Issue'} #${issue.number} queued and dispatched.`;

        const dispatchedPacketId = dispatchPayload.packetId ?? dispatchPayload.task?.packetId ?? payload.taskId ?? null;
        const dispatchedLaneId = dispatchPayload.laneId ?? dispatchPayload.task?.laneId ?? null;
        const dispatchedSessionKey = dispatchPayload.task?.lane?.sessionKey ?? null;
        const candidate: PendingDispatch = {
          packetId: dispatchedPacketId,
          laneId: dispatchedLaneId,
          sessionKey: dispatchedSessionKey,
          startedAt: Date.now(),
        };
        const immediateKey = findDispatchSessionKey(candidate, ideWorkspaceSessions);
        if (immediateKey) {
          onSelectSession?.(immediateKey);
          setPendingDispatch(null);
        } else if (candidate.packetId || candidate.sessionKey) {
          setPendingDispatch(candidate);
        }
      }
      setNotice(finalNote);
      await refresh(false);
      await loadIssueIntake(true);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Issue intake failed.');
    } finally {
      setBusyKey(null);
    }
  }, [ideWorkspaceSessions, loadIssueIntake, onSelectSession, project.id, refresh]);

  const scopedTasks = useMemo(() => (
    tasks.filter((task) => taskMatchesProject(task, project, repos, selectedRepo))
  ), [project, repos, selectedRepo, tasks]);

  const scopedSupervisorIncidents = useMemo(() => (
    supervisorItems
      .filter((item) => item.status === 'human_required' || item.status === 'pending' || item.status === 'healing' || item.status === 'escalated')
      .filter((item) => supervisorIncidentMatchesProject(item, repos, selectedRepo))
      .slice(0, 8)
  ), [repos, selectedRepo, supervisorItems]);

  const queuedIssueKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const task of scopedTasks) {
      if (!task.sourceIssue) continue;
      keys.add(issueKey(task.repoPath, task.sourceIssue));
    }
    return keys;
  }, [scopedTasks]);

  const grouped = useMemo(() => ({
    blocked: scopedTasks.filter((task) => task.group === 'blocked'),
    review: scopedTasks.filter((task) => task.group === 'review'),
    running: scopedTasks.filter((task) => task.group === 'running'),
    ready: scopedTasks.filter((task) => task.group === 'ready'),
    done: scopedTasks.filter((task) => task.group === 'done'),
  }), [scopedTasks]);

  const activeTasks = useMemo(() => (
    scopedTasks.filter((task) => task.group !== 'done')
  ), [scopedTasks]);
  const cleanupTasks = useMemo(() => (
    activeTasks.filter(isStaleTask)
  ), [activeTasks]);
  const cleanupTaskIds = useMemo(() => new Set(cleanupTasks.map((task) => task.id)), [cleanupTasks]);
  const liveActiveTasks = useMemo(() => (
    activeTasks.filter((task) => !cleanupTaskIds.has(task.id))
  ), [activeTasks, cleanupTaskIds]);
  const liveRunningTasks = useMemo(() => (
    grouped.running.filter((task) => !cleanupTaskIds.has(task.id))
  ), [cleanupTaskIds, grouped.running]);
  const liveReadyTasks = useMemo(() => (
    grouped.ready.filter((task) => !cleanupTaskIds.has(task.id))
  ), [cleanupTaskIds, grouped.ready]);
  const activeLocks = useMemo(() => (
    liveActiveTasks.filter((task) => task.laneId || task.lane?.id).length
  ), [liveActiveTasks]);
  const openSessionKeys = useMemo(() => new Set(ideWorkspaceSessions.map((session) => session.sessionKey)), [ideWorkspaceSessions]);
  const sessionBound = useMemo(() => (
    liveActiveTasks.filter((task) => task.lane?.sessionKey && openSessionKeys.has(task.lane.sessionKey)).length
  ), [liveActiveTasks, openSessionKeys]);
  const attentionTasks = useMemo(() => (
    [...grouped.blocked, ...grouped.review]
  ), [grouped.blocked, grouped.review]);
  const urgentAttentionTasks = useMemo(() => (
    attentionTasks.filter((task) => !cleanupTaskIds.has(task.id))
  ), [attentionTasks, cleanupTaskIds]);
  const liveBlockedTasks = useMemo(() => (
    grouped.blocked.filter((task) => !cleanupTaskIds.has(task.id))
  ), [cleanupTaskIds, grouped.blocked]);
  const liveReviewTasks = useMemo(() => (
    grouped.review.filter((task) => !cleanupTaskIds.has(task.id))
  ), [cleanupTaskIds, grouped.review]);

  const pruneCleanupTasks = useCallback(async () => {
    if (cleanupTasks.length === 0) return;
    setBusyKey('archive:stale-cleanup');
    setNotice(null);
    try {
      let archived = 0;
      const failures: string[] = [];
      for (const task of cleanupTasks) {
        try {
          const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/archive`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              actor: 'orchestrator',
              projectId: task.project?.id ?? project.id,
              repoPath: task.repoPath ?? selectedRepo?.localPath ?? null,
              reason: 'Pruned stale Control Room row.',
            }),
          });
          const payload = await response.json().catch(() => ({})) as Partial<TaskMutationPayload> & { error?: string };
          if (!response.ok || payload.ok === false) {
            throw new Error(payload.error ?? payload.note ?? 'archive failed');
          }
          archived += 1;
        } catch (err) {
          failures.push(`${task.title}: ${err instanceof Error ? err.message : 'archive failed'}`);
        }
      }
      setNotice(failures.length === 0
        ? `Pruned ${archived} stale task${archived === 1 ? '' : 's'} into Done / archived.`
        : `Pruned ${archived}; ${failures.length} failed.`);
      await refresh(true);
    } finally {
      setBusyKey(null);
    }
  }, [cleanupTasks, project.id, refresh, selectedRepo?.localPath]);

  const pruneDoneTasks = useCallback(async () => {
    if (grouped.done.length === 0) return;
    setBusyKey('prune:done-archived');
    setNotice(null);
    try {
      let pruned = 0;
      const failures: string[] = [];
      for (const task of grouped.done) {
        try {
          const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/prune`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              actor: 'orchestrator',
              projectId: task.project?.id ?? project.id,
              repoPath: task.repoPath ?? selectedRepo?.localPath ?? null,
              reason: 'Pruned done Control Room row.',
            }),
          });
          const payload = await response.json().catch(() => ({})) as Partial<TaskMutationPayload> & { error?: string };
          if (!response.ok || payload.ok === false) {
            throw new Error(payload.error ?? payload.note ?? 'prune failed');
          }
          pruned += 1;
        } catch (err) {
          failures.push(`${task.title}: ${err instanceof Error ? err.message : 'prune failed'}`);
        }
      }
      setNotice(failures.length === 0
        ? `Pruned ${pruned} done task${pruned === 1 ? '' : 's'} from Control Room.`
        : `Pruned ${pruned}; ${failures.length} failed.`);
      await refresh(true);
    } finally {
      setBusyKey(null);
    }
  }, [grouped.done, project.id, refresh, selectedRepo?.localPath]);

  const dismissSupervisorIncident = useCallback(async (item: SupervisorInboxItem) => {
    setBusyKey(`supervisor-dismiss:${item.id}`);
    setNotice(null);
    try {
      const response = await fetch('/api/panel/supervisor-inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dismiss', id: item.id }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setNotice('Supervisor incident dismissed.');
      await loadSupervisorIncidents(true);
      window.dispatchEvent(new CustomEvent('o8:supervisor-inbox'));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Unable to dismiss supervisor incident.');
    } finally {
      setBusyKey(null);
    }
  }, [loadSupervisorIncidents]);

  return (
    <div
      ref={rootRef}
      style={{
        minHeight: '100%',
        paddingTop: 8,
        paddingRight: 12,
        paddingBottom: 18,
        paddingLeft: 12,
        position: 'relative',
        fontFamily: REPO_FOCUS_FONT,
      }}
    >
      {composerOpen ? (
        <NewTaskComposer
          repos={repos}
          selectedRepo={selectedRepo}
          title={newTaskTitle}
          summary={newTaskSummary}
          repoPath={newTaskRepoPath}
          workerIntent={newTaskIntent}
          busy={busyKey === 'create' || busyKey === 'create-dispatch'}
          onTitleChange={setNewTaskTitle}
          onSummaryChange={setNewTaskSummary}
          onRepoPathChange={setNewTaskRepoPath}
          onWorkerIntentChange={setNewTaskIntent}
          onCancel={() => setComposerOpen(false)}
          onCreate={() => { void createControlTask(false); }}
          onCreateAndDispatch={() => { void createControlTask(true); }}
        />
      ) : null}

      {notice ? (
        <div
          style={{
            marginTop: 8,
            borderRadius: 10,
            border: '1px solid var(--t-divider-subtle)',
            background: 'color-mix(in srgb, var(--t-panel) 78%, transparent)',
            color: 'var(--t-text-muted)',
            paddingTop: 7,
            paddingRight: 9,
            paddingBottom: 7,
            paddingLeft: 9,
            fontSize: 10.5,
            lineHeight: '14px',
          }}
        >
          {notice}
        </div>
      ) : null}

      <TaskStatusStrip
        counts={{
          blocked: liveBlockedTasks.length,
          review: liveReviewTasks.length,
          running: liveRunningTasks.length,
          ready: liveReadyTasks.length,
        }}
        composerOpen={composerOpen}
        refreshing={refreshing}
        onCreateTask={() => setComposerOpen((current) => !current)}
        onRefresh={() => { void refresh(false); }}
      />

      <div
        style={{
          marginTop: 7,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minHeight: 28,
          borderBottom: '1px solid var(--t-divider-subtle)',
          color: 'var(--t-text-muted)',
          fontSize: 10.5,
          lineHeight: '14px',
        }}
      >
        <ShieldCheck size={14} strokeWidth={2} style={{ color: 'var(--t-accent)', flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Codex-only dispatch lock
        </span>
        <span style={{ color: 'var(--t-text-faint)', flexShrink: 0 }}>
          {activeLocks} locks - {sessionBound} open
        </span>
      </div>

      <div style={isWide ? { display: 'flex', gap: 14, alignItems: 'flex-start', marginTop: 4 } : { marginTop: 4 }}>
        <div style={isWide ? { flex: '1.6 1 0', minWidth: 0 } : undefined}>
          <GitHubIntakeSection
            issues={issueIntake}
            loading={issueLoading}
            refreshing={issueRefreshing}
            error={issueError}
            repoCount={intakeRepos.length}
            selectedRepoName={selectedRepo?.name ?? null}
            queuedIssueKeys={queuedIssueKeys}
            busyKey={busyKey}
            onRefresh={() => { void loadIssueIntake(false); }}
            onQueue={(issue) => { void createIssueTask(issue, false); }}
            onDispatch={(issue) => { void createIssueTask(issue, true); }}
          />
        </div>

        <div style={isWide ? { flex: '1 1 0', minWidth: 0 } : undefined}>
          <SupervisorIncidentSection
            items={scopedSupervisorIncidents}
            loading={supervisorLoading}
            refreshing={supervisorRefreshing}
            error={supervisorError}
            busyKey={busyKey}
            onRefresh={() => { void loadSupervisorIncidents(false); }}
            onDismiss={(item) => { void dismissSupervisorIncident(item); }}
          />

          {error ? (
            <StatusMessage icon={<AlertCircle size={14} strokeWidth={2} />} tone="#dc2626" title="Task pool unavailable" body={error} />
          ) : null}

          {!error && loading ? (
            <StatusMessage icon={<Clock size={14} strokeWidth={2} />} tone="var(--t-text-muted)" title="Loading task pool" body="Reading packets, lanes, and routing state." />
          ) : null}

          {!error && !loading && activeTasks.length === 0 ? (
            <StatusMessage icon={<CheckCircle2 size={14} strokeWidth={2} />} tone="#16a34a" title="No active pool items" body="This scope has no blocked, review, running, or ready tasks." />
          ) : null}

          {!error && !loading && activeTasks.length > 0 ? (
            <>
              {attentionTasks.length > 0 ? (
                <TaskSection
                  label="Needs decision"
                  tasks={urgentAttentionTasks}
                  activeSessionKey={activeSessionKey}
                  onSelectSession={onSelectSession}
                  onOpenMenu={(task, x, y) => setActionMenu({ task, x, y })}
                  emptyLabel={cleanupTasks.length > 0 ? 'No fresh blockers or reviews.' : undefined}
                  compactActions
                />
              ) : null}
              {cleanupTasks.length > 0 ? (
                <CollapsedTaskSection
                  label="Stale / cleanup"
                  tasks={cleanupTasks}
                  open={staleAttentionOpen}
                  onToggle={() => setStaleAttentionOpen((current) => !current)}
                  activeSessionKey={activeSessionKey}
                  onSelectSession={onSelectSession}
                  onOpenMenu={(task, x, y) => setActionMenu({ task, x, y })}
                  limit={6}
                  compactActions
                  overflowLabel="stale task"
                  actionLabel="Prune stale tasks"
                  actionDisabled={busyKey === 'archive:stale-cleanup'}
                  actionIcon={<Archive size={12} strokeWidth={2} />}
                  onAction={() => { void pruneCleanupTasks(); }}
                />
              ) : null}
              <TaskSection
                label="Working"
                tasks={liveRunningTasks}
                activeSessionKey={activeSessionKey}
                onSelectSession={onSelectSession}
                onOpenMenu={(task, x, y) => setActionMenu({ task, x, y })}
                emptyLabel={cleanupTasks.length > 0 ? 'No live workers.' : attentionTasks.length === 0 ? 'No running workers.' : undefined}
              />
              <TaskSection
                label="Ready pool"
                tasks={liveReadyTasks}
                activeSessionKey={activeSessionKey}
                onSelectSession={onSelectSession}
                onOpenMenu={(task, x, y) => setActionMenu({ task, x, y })}
                limit={6}
                emptyLabel={cleanupTasks.length > 0 ? 'No queued tasks.' : attentionTasks.length === 0 && liveRunningTasks.length === 0 ? 'No queued tasks.' : undefined}
              />
            </>
          ) : null}

          {!error && !loading && grouped.done.length > 0 ? (
            <CollapsedTaskSection
              label="Done / archived"
              tasks={grouped.done}
              open={doneOpen}
              onToggle={() => setDoneOpen((current) => !current)}
              activeSessionKey={activeSessionKey}
              onSelectSession={onSelectSession}
              onOpenMenu={(task, x, y) => setActionMenu({ task, x, y })}
              limit={8}
              actionLabel="Prune done tasks"
              actionDisabled={busyKey === 'prune:done-archived'}
              actionIcon={<Archive size={12} strokeWidth={2} />}
              onAction={() => { void pruneDoneTasks(); }}
            />
          ) : null}
        </div>
      </div>

      {actionMenu ? (
        <TaskActionMenu
          state={actionMenu}
          busyKey={busyKey}
          onClose={() => setActionMenu(null)}
          onSelectSession={onSelectSession}
          onAction={(task, action, body) => { void mutateTask(task, action, body); }}
        />
      ) : null}
    </div>
  );
}
