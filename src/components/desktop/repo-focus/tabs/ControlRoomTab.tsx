'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import type { SupervisorInboxItem } from '@/lib/supervisor/inbox';
import { ClaudeIcon, CodexIcon, GeminiIcon, OpenCodeIcon } from '@/components/desktop/repo-registry/shared';
import { AlertCircle, Archive, CheckCircle2, ChevronDown, Clock, ExternalLink, GitPullRequest, MoreHorizontal, Play, Plus, RefreshCw, ShieldCheck, Sparkles, X } from '../../lucide-shims';
import type { IdeWorkspaceSession, RepoFocusRepo } from '../types';
import {
  formatElapsed,
  normalizeRepoPath,
  repoOwnsCandidate,
  REPO_FOCUS_FONT,
} from '../utils';
import type { ProjectRecord } from '../../repo-registry/useProjects';

type TaskPoolGroup = 'ready' | 'running' | 'review' | 'blocked' | 'done';

interface TaskPoolLaneSummary {
  id: string;
  label: string;
  status: string;
  runtime: string;
  branch: string;
  baseBranch: string;
  sessionKey: string | null;
  worktreePath: string | null;
  lastHeartbeatAt: number | null;
  lastEventAt: string | null;
  lastEventLabel: string | null;
}

interface TaskPoolWorkerRouting {
  workerIntent: string;
  requestedProvider: string | null;
  requestedRuntime: string | null;
  requestedModel: string | null;
  selectedProvider: string;
  selectedRuntime: string;
  selectedModel: string | null;
  enforcement: string;
  confidence: string;
  reason: string;
  decidedAt: string;
}

interface TaskPoolProjectSummary {
  id: string;
  name: string;
  slug: string;
}

interface TaskPoolTask {
  id: string;
  packetId: string | null;
  laneId: string | null;
  title: string;
  summary: string;
  group: TaskPoolGroup;
  status: string;
  runtime: string;
  workerIntent: string | null;
  workerRouting: TaskPoolWorkerRouting | null;
  branch: string | null;
  baseBranch: string | null;
  repoPath: string | null;
  repoName: string | null;
  blockedReason: string | null;
  lastEventAt: string | null;
  lastEventLabel: string | null;
  allowedFiles: string[];
  sourceIssue: {
    number?: number | null;
    body?: string | null;
    url?: string | null;
  } | null;
  project: TaskPoolProjectSummary | null;
  lane: TaskPoolLaneSummary | null;
}

interface TaskPoolPayload {
  schema: 'o8/task.pool/v1';
  tasks: TaskPoolTask[];
}

interface SupervisorInboxPayload {
  items?: SupervisorInboxItem[];
}

interface TaskMutationPayload {
  schema: 'o8/task.mutation/v1';
  ok: boolean;
  action: 'create' | 'claim' | 'dispatch' | 'block' | 'report' | 'archive' | 'prune';
  taskId: string;
  packetId: string | null;
  laneId: string | null;
  note: string;
  task: TaskPoolTask | null;
}

interface GitHubIssueIntake {
  id: string;
  kind: 'issue' | 'epic';
  repoId: string;
  repoName: string;
  repoPath: string;
  repoFullName: string;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  comments: number;
  updatedAt: string | null;
  age: string;
}

interface PanelIssuePayload {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  labels?: unknown;
  comments?: unknown;
  body?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
  url?: unknown;
}

interface ControlRoomTabProps {
  project: ProjectRecord;
  repos: RepoFocusRepo[];
  selectedRepo?: RepoFocusRepo | null;
  ideWorkspaceSessions?: IdeWorkspaceSession[];
  activeSessionKey?: string | null;
  onSelectSession?: (sessionKey: string) => void;
}

type TaskAction = 'claim' | 'dispatch' | 'block' | 'report' | 'archive' | 'prune';

interface TaskActionMenuState {
  task: TaskPoolTask;
  x: number;
  y: number;
}

const GROUP_LABELS: Record<TaskPoolGroup, string> = {
  ready: 'Ready',
  running: 'Running',
  review: 'Review',
  blocked: 'Blocked',
  done: 'Done',
};

const GROUP_TONES: Record<TaskPoolGroup, {
  text: string;
  dot: string;
  soft: string;
}> = {
  ready: {
    text: 'var(--t-text-muted)',
    dot: 'var(--t-text-faint)',
    soft: 'var(--t-input-bg)',
  },
  running: {
    text: 'var(--t-accent)',
    dot: 'var(--t-accent)',
    soft: 'color-mix(in srgb, var(--t-accent) 10%, transparent)',
  },
  review: {
    text: 'var(--t-brand-orange, #FF5A1F)',
    dot: 'var(--t-brand-orange, #FF5A1F)',
    soft: 'rgba(255, 90, 31, 0.08)',
  },
  blocked: {
    text: '#dc2626',
    dot: '#ef4444',
    soft: 'rgba(239, 68, 68, 0.08)',
  },
  done: {
    text: '#15803d',
    dot: '#16a34a',
    soft: 'rgba(22, 163, 74, 0.08)',
  },
};

const FLOATING_GLASS_SURFACE = 'color-mix(in srgb, var(--t-panel) 92%, transparent)';
const FLAT_HOVER_SURFACE = 'color-mix(in srgb, var(--t-hover) 70%, transparent)';
const FIELD_SURFACE = 'color-mix(in srgb, var(--t-panel) 88%, transparent)';
const ONE_HOUR_MS = 60 * 60 * 1000;
const STALE_FAILURE_MS = 6 * ONE_HOUR_MS;
const STALE_ATTENTION_MS = 72 * ONE_HOUR_MS;
const DETACHED_ATTENTION_MS = 24 * ONE_HOUR_MS;
const STALE_CLEANUP_SIGNALS = new Set([
  'launch_error',
  'launch_failed',
  'relaunch_error',
  'session_lost',
  'zero_diff_failed',
  'silent_exit_work_present',
]);

function projectSlug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function baseName(value: string | null | undefined): string {
  return normalizeRepoPath(value).split('/').filter(Boolean).pop() ?? '';
}

function repoSlugFromRemote(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  const normalized = remoteUrl
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const match = normalized.match(/github\.com\/([^/]+\/[^/]+)$/);
  return match?.[1] ?? null;
}

function repoIssueParam(repo: RepoFocusRepo): string {
  return repoSlugFromRemote(repo.remoteUrl) ?? repo.name;
}

function issueKind(labels: string[]): GitHubIssueIntake['kind'] {
  return labels.some((label) => /(^|\b)(epic|initiative|milestone)(\b|$)/i.test(label)) ? 'epic' : 'issue';
}

function issueAge(issue: { updatedAt?: string | null; createdAt?: string | null }): string {
  return formatElapsed(issue.updatedAt ?? issue.createdAt ?? null);
}

function issueKey(repoPath: string | null | undefined, issue: { number?: number | null; url?: string | null }) {
  return `${normalizeRepoPath(repoPath)}::${issue.url ?? issue.number ?? ''}`;
}

function intentLabel(value: string | null | undefined): string {
  switch (value) {
    case 'light_worker':
      return 'light worker';
    case 'heavy_worker':
      return 'heavy worker';
    case 'reviewer':
      return 'reviewer';
    case 'diagnostic':
      return 'diagnostic';
    case 'orchestrator':
      return 'orchestrator';
    default:
      return 'worker';
  }
}

function runtimeLabel(value: string | null | undefined): string {
  switch (value) {
    case 'claude-code':
      return 'Claude';
    case 'gemini':
      return 'Gemini';
    case 'opencode':
      return 'opencode';
    case 'codex':
      return 'Codex';
    default:
      return value || 'Codex';
  }
}

function RuntimeIcon({ runtime, size = 14 }: { runtime?: string | null; size?: number }) {
  switch (runtime) {
    case 'claude-code':
      return <ClaudeIcon size={size} />;
    case 'gemini':
      return <GeminiIcon size={size} />;
    case 'opencode':
      return <OpenCodeIcon size={size} />;
    default:
      return <CodexIcon size={size} />;
  }
}

function taskTime(task: TaskPoolTask): string {
  const value = task.lastEventAt ?? task.lane?.lastEventAt ?? task.lane?.lastHeartbeatAt ?? null;
  return formatElapsed(value);
}

function taskTimeLabel(task: TaskPoolTask): string {
  const elapsed = taskTime(task);
  return elapsed === 'now' ? 'now' : `${elapsed} ago`;
}

function taskTimestampMs(task: TaskPoolTask): number | null {
  const raw = task.lastEventAt ?? task.lane?.lastEventAt ?? null;
  if (raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  const heartbeat = task.lane?.lastHeartbeatAt;
  return typeof heartbeat === 'number' && Number.isFinite(heartbeat) ? heartbeat : null;
}

function isAttentionTask(task: TaskPoolTask): boolean {
  return task.group === 'blocked' || task.group === 'review';
}

function isStaleTask(task: TaskPoolTask): boolean {
  const timestamp = taskTimestampMs(task);
  if (timestamp === null) return false;
  const age = Date.now() - timestamp;
  const signal = task.blockedReason || task.lastEventLabel || task.lane?.lastEventLabel || null;
  if (signal && STALE_CLEANUP_SIGNALS.has(signal) && age > STALE_FAILURE_MS) return true;
  if (isAttentionTask(task) && age > STALE_ATTENTION_MS) return true;
  if (isAttentionTask(task) && !task.lane?.sessionKey && age > DETACHED_ATTENTION_MS) return true;
  return task.lane?.status === 'failed' && age > STALE_FAILURE_MS;
}

function taskSignal(task: TaskPoolTask): string | null {
  const value = task.blockedReason || task.lastEventLabel || null;
  switch (value) {
    case 'zero_diff_failed':
      return 'No changes produced';
    case 'silent_exit_work_present':
      return 'Work present';
    case 'review_ready':
      return 'Ready to review';
    case 'needs_clarification':
      return 'Needs clarification';
    default:
      return value;
  }
}

function taskMatchesProject(
  task: TaskPoolTask,
  project: ProjectRecord,
  repos: RepoFocusRepo[],
  selectedRepo: RepoFocusRepo | null | undefined,
): boolean {
  const repoPath = normalizeRepoPath(task.repoPath);
  const targets = selectedRepo ? [selectedRepo] : repos;
  if (repoPath && targets.some((repo) => repoOwnsCandidate(repo.localPath, repoPath))) return true;
  if (selectedRepo) return false;

  const ids = new Set([
    project.id.toLowerCase(),
    project.name.toLowerCase(),
    projectSlug(project.name),
  ].filter(Boolean));
  const taskProject = task.project;
  if (!taskProject) return false;
  return ids.has(taskProject.id.toLowerCase())
    || ids.has(taskProject.slug.toLowerCase())
    || ids.has(taskProject.name.toLowerCase());
}

function supervisorIncidentMatchesProject(
  item: SupervisorInboxItem,
  repos: RepoFocusRepo[],
  selectedRepo: RepoFocusRepo | null | undefined,
): boolean {
  const repoPath = normalizeRepoPath(item.repoPath);
  const targets = selectedRepo ? [selectedRepo] : repos;
  if (!repoPath) return false;
  return targets.some((repo) => repoOwnsCandidate(repo.localPath, repoPath));
}

function supervisorKindLabel(kind: SupervisorInboxItem['kind']): string {
  switch (kind) {
    case 'verification_failed':
      return 'Verification failed';
    case 'session_lost':
      return 'Session lost';
    case 'packet_missing':
      return 'Packet missing';
    case 'bounded_retry_exhausted':
      return 'Retry exhausted';
    case 'merge_blocked':
      return 'Merge blocked';
    case 'fetch_unreachable':
      return 'Fetch unreachable';
    case 'repo_misconfigured':
      return 'Repo misconfigured';
    case 'silent_exit_verification_failed':
      return 'Silent exit';
    case 'silent_exit_no_work':
      return 'No work';
    case 'silent_exit_but_work_present':
      return 'Work salvaged';
    default:
      return 'Agent triage';
  }
}

function supervisorStatusTone(status: SupervisorInboxItem['status']) {
  switch (status) {
    case 'human_required':
      return {
        label: 'Needs decision',
        color: '#dc2626',
        background: 'rgba(239, 68, 68, 0.08)',
      };
    case 'healing':
      return {
        label: 'Healing',
        color: 'var(--t-accent)',
        background: 'color-mix(in srgb, var(--t-accent) 10%, transparent)',
      };
    case 'pending':
      return {
        label: 'Queued',
        color: 'var(--t-brand-orange, #FF5A1F)',
        background: 'rgba(255, 90, 31, 0.08)',
      };
    case 'self_healed':
      return {
        label: 'Fixed',
        color: '#16a34a',
        background: 'rgba(22, 163, 74, 0.08)',
      };
    default:
      return {
        label: 'Archived',
        color: 'var(--t-text-faint)',
        background: 'transparent',
      };
  }
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
    } catch (err) {
      setNotice(err instanceof Error ? err.message : `Task ${action} failed.`);
    } finally {
      setBusyKey(null);
    }
  }, [project.id, refresh, selectedRepo?.localPath]);

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
      }
      setNotice(finalNote);
      await refresh(false);
      await loadIssueIntake(true);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Issue intake failed.');
    } finally {
      setBusyKey(null);
    }
  }, [loadIssueIntake, project.id, refresh]);

  const scopedTasks = useMemo(() => (
    tasks.filter((task) => taskMatchesProject(task, project, repos, selectedRepo))
  ), [project, repos, selectedRepo, tasks]);

  const scopedSupervisorIncidents = useMemo(() => (
    supervisorItems
      .filter((item) => item.status === 'human_required' || item.status === 'pending' || item.status === 'healing')
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

      <SupervisorIncidentSection
        items={scopedSupervisorIncidents}
        loading={supervisorLoading}
        refreshing={supervisorRefreshing}
        error={supervisorError}
        busyKey={busyKey}
        onRefresh={() => { void loadSupervisorIncidents(false); }}
        onDismiss={(item) => { void dismissSupervisorIncident(item); }}
      />

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

function TaskStatusStrip({
  counts,
  composerOpen,
  refreshing,
  onCreateTask,
  onRefresh,
}: {
  counts: Record<'blocked' | 'review' | 'running' | 'ready', number>;
  composerOpen: boolean;
  refreshing: boolean;
  onCreateTask: () => void;
  onRefresh: () => void;
}) {
  const groups: Array<'blocked' | 'review' | 'running' | 'ready'> = ['blocked', 'review', 'running', 'ready'];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        minHeight: 30,
        borderBottom: '1px solid var(--t-divider-subtle)',
        overflowX: 'auto',
        scrollbarWidth: 'none',
      }}
    >
      {groups.map((group) => (
        <StatusChip key={group} group={group} count={counts[group]} />
      ))}
      <span style={{ flex: 1, minWidth: 8 }} />
      <IconActionButton
        label="Create task"
        active={composerOpen}
        onClick={onCreateTask}
      >
        <Plus size={13} strokeWidth={2.2} />
      </IconActionButton>
      <IconActionButton
        label="Refresh task pool"
        active={refreshing}
        onClick={onRefresh}
      >
        <RefreshCw size={12} strokeWidth={2} />
      </IconActionButton>
    </div>
  );
}

function IconActionButton({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 23,
        height: 23,
        borderRadius: 8,
        borderWidth: 0,
        background: active ? FLAT_HOVER_SURFACE : 'transparent',
        color: disabled ? 'var(--t-text-faint)' : active ? 'var(--t-accent)' : 'var(--t-text-muted)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        flexShrink: 0,
        transition: 'background 140ms ease, color 140ms ease',
      }}
      onMouseEnter={(event) => {
        if (!disabled) event.currentTarget.style.background = FLAT_HOVER_SURFACE;
      }}
      onMouseLeave={(event) => { event.currentTarget.style.background = active ? FLAT_HOVER_SURFACE : 'transparent'; }}
    >
      {children}
    </button>
  );
}

function GitHubIntakeSection({
  issues,
  loading,
  refreshing,
  error,
  repoCount,
  selectedRepoName,
  queuedIssueKeys,
  busyKey,
  onRefresh,
  onQueue,
  onDispatch,
}: {
  issues: GitHubIssueIntake[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  repoCount: number;
  selectedRepoName: string | null;
  queuedIssueKeys: Set<string>;
  busyKey: string | null;
  onRefresh: () => void;
  onQueue: (issue: GitHubIssueIntake) => void;
  onDispatch: (issue: GitHubIssueIntake) => void;
}) {
  const visibleIssues = issues.slice(0, 6);
  const overflow = issues.length - visibleIssues.length;
  const scopeLabel = selectedRepoName
    ? selectedRepoName
    : `${repoCount} repo${repoCount === 1 ? '' : 's'}`;

  return (
    <section
      style={{
        marginTop: 9,
        borderBottom: '1px solid var(--t-divider-subtle)',
        paddingBottom: 9,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              color: 'var(--t-text-faint)',
              fontSize: 10,
              lineHeight: '13px',
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            GitHub intake
          </div>
          <div style={{ marginTop: 1, color: 'var(--t-text-muted)', fontSize: 10.5, lineHeight: '14px' }}>
            {selectedRepoName ? `Scoped to ${scopeLabel}` : `Issues + epics from ${scopeLabel}`}
          </div>
        </div>
        <IconActionButton
          label="Refresh GitHub intake"
          active={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw size={12} strokeWidth={2} />
        </IconActionButton>
      </div>

      {error ? (
        <div style={{ color: '#dc2626', fontSize: 10.5, lineHeight: '14px', paddingTop: 5 }}>
          {error}
        </div>
      ) : null}

      {loading ? (
        <div style={{ color: 'var(--t-text-faint)', fontSize: 11, lineHeight: '15px', paddingTop: 7 }}>
          Loading project issues...
        </div>
      ) : null}

      {!loading && visibleIssues.length === 0 ? (
        <div style={{ color: 'var(--t-text-faint)', fontSize: 11, lineHeight: '15px', paddingTop: 7 }}>
          No open GitHub issues found for this scope.
        </div>
      ) : null}

      {!loading ? visibleIssues.map((issue) => {
        const queued = queuedIssueKeys.has(issueKey(issue.repoPath, issue));
        const busy = busyKey === `issue-create:${issue.id}` || busyKey === `issue-dispatch:${issue.id}`;
        return (
          <div
            key={issue.id}
            style={{
              minHeight: 40,
              display: 'grid',
              gridTemplateColumns: '20px minmax(0, 1fr) auto',
              gap: 8,
              alignItems: 'center',
              borderTop: '1px solid var(--t-divider-subtle)',
              paddingTop: 6,
              paddingBottom: 6,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 20,
                height: 20,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: issue.kind === 'epic' ? 'var(--t-accent)' : 'var(--t-brand-orange, #FF5A1F)',
              }}
            >
              {issue.kind === 'epic' ? <Sparkles size={13} strokeWidth={2} /> : <GitPullRequest size={13} strokeWidth={2} />}
            </span>
            <span style={{ minWidth: 0 }}>
              <span
                style={{
                  display: 'block',
                  color: 'var(--t-text)',
                  fontSize: 11.75,
                  lineHeight: '15px',
                  fontWeight: 540,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {issue.title}
              </span>
              <span
                style={{
                  display: 'block',
                  marginTop: 1,
                  color: 'var(--t-text-faint)',
                  fontSize: 10.25,
                  lineHeight: '13px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {issue.repoName} - {issue.kind} #{issue.number} - {issue.comments} comment{issue.comments === 1 ? '' : 's'} - {issue.age} ago
              </span>
            </span>
            {queued ? (
              <span
                title="Queued"
                style={{
                  width: 25,
                  height: 25,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--t-accent)',
                }}
              >
                <CheckCircle2 size={13} strokeWidth={2.1} />
              </span>
            ) : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <IconActionButton
                  label={`Queue ${issue.title}`}
                  disabled={busy}
                  onClick={() => onQueue(issue)}
                >
                  <Plus size={12} strokeWidth={2.1} />
                </IconActionButton>
                <IconActionButton
                  label={`Dispatch ${issue.title}`}
                  active
                  disabled={busy}
                  onClick={() => onDispatch(issue)}
                >
                  <Play size={12} strokeWidth={2.2} />
                </IconActionButton>
              </span>
            )}
          </div>
        );
      }) : null}

      {!loading && overflow > 0 ? (
        <div style={{ paddingTop: 5, color: 'var(--t-text-faint)', fontSize: 10.5, lineHeight: '14px' }}>
          + {overflow} more issue{overflow === 1 ? '' : 's'} in this scope
        </div>
      ) : null}
    </section>
  );
}

function SupervisorIncidentSection({
  items,
  loading,
  refreshing,
  error,
  busyKey,
  onRefresh,
  onDismiss,
}: {
  items: SupervisorInboxItem[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  busyKey: string | null;
  onRefresh: () => void;
  onDismiss: (item: SupervisorInboxItem) => void;
}) {
  if (!loading && !error && items.length === 0) {
    return null;
  }

  return (
    <section
      style={{
        borderBottom: '1px solid var(--t-divider-subtle)',
        paddingTop: 8,
        paddingBottom: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              color: 'var(--t-text-faint)',
              fontSize: 10,
              lineHeight: '13px',
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            Agent triage
          </div>
        </div>
        <span style={{ color: 'var(--t-text-faint)', fontSize: 9.5, lineHeight: '12px', flexShrink: 0 }}>
          {items.length}
        </span>
        <IconActionButton
          label="Refresh agent triage"
          active={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw size={12} strokeWidth={2} />
        </IconActionButton>
      </div>

      {error ? (
        <div style={{ color: '#dc2626', fontSize: 10.5, lineHeight: '14px', paddingTop: 5 }}>
          {error}
        </div>
      ) : null}

      {loading ? (
        <div style={{ color: 'var(--t-text-faint)', fontSize: 11, lineHeight: '15px', paddingTop: 7 }}>
          Reading supervisor incidents...
        </div>
      ) : null}

      {!loading ? items.map((item) => (
        <SupervisorIncidentRow
          key={item.id}
          item={item}
          busy={busyKey === `supervisor-dismiss:${item.id}`}
          onDismiss={onDismiss}
        />
      )) : null}
    </section>
  );
}

function SupervisorIncidentRow({
  item,
  busy,
  onDismiss,
}: {
  item: SupervisorInboxItem;
  busy: boolean;
  onDismiss: (item: SupervisorInboxItem) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const tone = supervisorStatusTone(item.status);
  const repoName = baseName(item.repoPath) || 'repo';
  const title = item.packetTitle ?? item.packetReferenceLabel ?? supervisorKindLabel(item.kind);
  const verificationKind = typeof item.payload.verificationKind === 'string'
    ? item.payload.verificationKind
    : null;
  const metaParts = [
    repoName,
    supervisorKindLabel(item.kind),
    `${formatElapsed(item.lastSeenAt)} ago`,
  ];

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        minHeight: 42,
        display: 'grid',
        gridTemplateColumns: '20px minmax(0, 1fr) auto',
        gap: 8,
        alignItems: 'center',
        borderTop: '1px solid var(--t-divider-subtle)',
        background: hovered ? FLAT_HOVER_SURFACE : 'transparent',
        paddingTop: 6,
        paddingBottom: 6,
        transition: 'background 140ms ease',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 20,
          height: 20,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: tone.color,
        }}
      >
        <AlertCircle size={13} strokeWidth={2} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            color: 'var(--t-text)',
            fontSize: 11.75,
            lineHeight: '15px',
            fontWeight: 540,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 1,
            color: 'var(--t-text-faint)',
            fontSize: 10.25,
            lineHeight: '13px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {metaParts.join(' - ')}
          {verificationKind ? ` - ${verificationKind}` : ''}
          {item.repeatCount > 1 ? ` - x${item.repeatCount}` : ''}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 1,
            color: item.status === 'human_required' ? '#dc2626' : 'var(--t-text-muted)',
            fontSize: 10,
            lineHeight: '13px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.errorExcerpt}
        </span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
        <span
          style={{
            minHeight: 18,
            display: 'inline-flex',
            alignItems: 'center',
            borderRadius: 7,
            background: tone.background,
            color: tone.color,
            paddingTop: 0,
            paddingRight: 5,
            paddingBottom: 0,
            paddingLeft: 5,
            fontSize: 9.25,
            lineHeight: '12px',
            fontWeight: 580,
          }}
        >
          {tone.label}
        </span>
        {item.transcriptLink ? (
          <TaskIconButton
            label="Open transcript"
            visible={hovered}
            active={false}
            onClick={(event) => {
              event.stopPropagation();
              window.open(item.transcriptLink ?? '', '_blank', 'noopener,noreferrer');
            }}
          >
            <ExternalLink size={12} strokeWidth={2} />
          </TaskIconButton>
        ) : null}
        <TaskIconButton
          label="Dismiss incident"
          visible={hovered}
          active={busy}
          onClick={(event) => {
            event.stopPropagation();
            if (!busy) onDismiss(item);
          }}
        >
          <Archive size={12} strokeWidth={2} />
        </TaskIconButton>
      </span>
    </div>
  );
}

function StatusChip({ group, count }: { group: 'blocked' | 'review' | 'running' | 'ready'; count: number }) {
  const tone = GROUP_TONES[group];
  return (
    <span
      style={{
        minWidth: 0,
        minHeight: 20,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        borderRadius: 999,
        color: tone.text,
        paddingTop: 0,
        paddingRight: 7,
        paddingBottom: 0,
        paddingLeft: 0,
        fontSize: 10,
        lineHeight: '12px',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      <span aria-hidden style={{ width: 5, height: 5, borderRadius: 999, background: tone.dot, flexShrink: 0 }} />
      <span style={{ color: 'var(--t-text-faint)', fontWeight: 560 }}>{GROUP_LABELS[group]}</span>
      <span style={{ fontWeight: 680 }}>{count}</span>
    </span>
  );
}

function NewTaskComposer({
  repos,
  selectedRepo,
  title,
  summary,
  repoPath,
  workerIntent,
  busy,
  onTitleChange,
  onSummaryChange,
  onRepoPathChange,
  onWorkerIntentChange,
  onCancel,
  onCreate,
  onCreateAndDispatch,
}: {
  repos: RepoFocusRepo[];
  selectedRepo?: RepoFocusRepo | null;
  title: string;
  summary: string;
  repoPath: string;
  workerIntent: string;
  busy: boolean;
  onTitleChange: (value: string) => void;
  onSummaryChange: (value: string) => void;
  onRepoPathChange: (value: string) => void;
  onWorkerIntentChange: (value: string) => void;
  onCancel: () => void;
  onCreate: () => void;
  onCreateAndDispatch: () => void;
}) {
  const fieldStyle: CSSProperties = {
    width: '100%',
    border: '1px solid var(--t-divider-subtle)',
    borderRadius: 10,
    background: FIELD_SURFACE,
    color: 'var(--t-text)',
    fontFamily: REPO_FOCUS_FONT,
    fontSize: 11.5,
    lineHeight: '16px',
    outline: 'none',
    paddingTop: 8,
    paddingRight: 10,
    paddingBottom: 8,
    paddingLeft: 10,
  };

  return (
    <div
      style={{
        marginTop: 10,
        border: '1px solid var(--t-divider-subtle)',
        borderRadius: 16,
        background: FLOATING_GLASS_SURFACE,
        boxShadow: '0 18px 46px rgba(15, 23, 42, 0.08)',
        backdropFilter: 'blur(18px) saturate(145%)',
        WebkitBackdropFilter: 'blur(18px) saturate(145%)',
        padding: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11.5, lineHeight: '15px', color: 'var(--t-text)', fontWeight: 640 }}>
            New task
          </div>
          <div style={{ marginTop: 1, fontSize: 10.25, lineHeight: '13px', color: 'var(--t-text-faint)' }}>
            Ready pool - Codex-only dispatch
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          title="Close"
          style={{
            width: 24,
            height: 24,
            border: 0,
            borderRadius: 8,
            background: 'transparent',
            color: 'var(--t-text-muted)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>
      <input
        value={title}
        onChange={(event) => onTitleChange(event.currentTarget.value)}
        placeholder="Task title"
        style={fieldStyle}
      />
      <textarea
        value={summary}
        onChange={(event) => onSummaryChange(event.currentTarget.value)}
        placeholder="Brief detail, constraints, or success criteria"
        rows={3}
        style={{
          ...fieldStyle,
          marginTop: 7,
          resize: 'vertical',
          minHeight: 58,
        }}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 7, marginTop: 7 }}>
        <select
          value={repoPath}
          disabled={Boolean(selectedRepo)}
          onChange={(event) => onRepoPathChange(event.currentTarget.value)}
          style={{
            ...fieldStyle,
            height: 34,
            paddingTop: 0,
            paddingBottom: 0,
            color: selectedRepo ? 'var(--t-text-faint)' : 'var(--t-text-muted)',
          }}
        >
          {repos.map((repo) => (
            <option key={repo.id} value={repo.localPath}>{repo.name}</option>
          ))}
        </select>
        <select
          value={workerIntent}
          onChange={(event) => onWorkerIntentChange(event.currentTarget.value)}
          style={{
            ...fieldStyle,
            height: 34,
            paddingTop: 0,
            paddingBottom: 0,
            color: 'var(--t-text-muted)',
          }}
        >
          <option value="heavy_worker">Heavy worker</option>
          <option value="light_worker">Light worker</option>
          <option value="diagnostic">Diagnostic</option>
          <option value="reviewer">Reviewer</option>
          <option value="orchestrator">Orchestrator</option>
        </select>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7, marginTop: 9 }}>
        <ActionButton label="Add" disabled={busy} onClick={onCreate} />
        <ActionButton label="Add + dispatch" icon={<Play size={12} strokeWidth={2.2} />} primary disabled={busy} onClick={onCreateAndDispatch} />
      </div>
    </div>
  );
}

function ActionButton({
  label,
  icon,
  primary = false,
  disabled = false,
  onClick,
}: {
  label: string;
  icon?: ReactNode;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        minHeight: 28,
        borderRadius: 9,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: primary ? 'color-mix(in srgb, var(--t-accent) 35%, var(--t-divider-subtle))' : 'var(--t-divider-subtle)',
        background: primary ? 'color-mix(in srgb, var(--t-accent) 11%, var(--t-panel))' : 'transparent',
        color: primary ? 'var(--t-accent)' : 'var(--t-text-muted)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.58 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        paddingTop: 0,
        paddingRight: 10,
        paddingBottom: 0,
        paddingLeft: 10,
        fontFamily: REPO_FOCUS_FONT,
        fontSize: 10.5,
        lineHeight: '14px',
        fontWeight: 620,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingTop: 13,
        paddingRight: 0,
        paddingBottom: 4,
        paddingLeft: 0,
        fontSize: 10,
        lineHeight: '13px',
        color: 'var(--t-text-faint)',
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      <span style={{ fontSize: 9.5, lineHeight: '12px', letterSpacing: 0, fontWeight: 500 }}>{count}</span>
    </div>
  );
}

function TaskSection({
  label,
  tasks,
  activeSessionKey,
  onSelectSession,
  onOpenMenu,
  limit,
  emptyLabel,
  compactActions = false,
}: {
  label: string;
  tasks: TaskPoolTask[];
  activeSessionKey?: string | null;
  onSelectSession?: (sessionKey: string) => void;
  onOpenMenu?: (task: TaskPoolTask, x: number, y: number) => void;
  limit?: number;
  emptyLabel?: string;
  compactActions?: boolean;
}) {
  if (tasks.length === 0) {
    if (!emptyLabel) return null;
    return (
      <div>
        <SectionLabel label={label} count={0} />
        <div style={{ paddingTop: 7, paddingBottom: 7, color: 'var(--t-text-faint)', fontSize: 11.5, lineHeight: '15px' }}>
          {emptyLabel}
        </div>
      </div>
    );
  }

  const visibleTasks = typeof limit === 'number' ? tasks.slice(0, limit) : tasks;
  const overflow = tasks.length - visibleTasks.length;

  return (
    <div>
      <SectionLabel label={label} count={tasks.length} />
      {visibleTasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          active={Boolean(task.lane?.sessionKey && task.lane.sessionKey === activeSessionKey)}
          onSelectSession={onSelectSession}
          onOpenMenu={onOpenMenu}
          compactActions={compactActions}
        />
      ))}
      {overflow > 0 ? (
        <div style={{ paddingTop: 6, paddingBottom: 2, color: 'var(--t-text-faint)', fontSize: 10.5, lineHeight: '14px' }}>
          + {overflow} more ready task{overflow === 1 ? '' : 's'}
        </div>
      ) : null}
    </div>
  );
}

function CollapsedTaskSection({
  label,
  tasks,
  open,
  onToggle,
  activeSessionKey,
  onSelectSession,
  onOpenMenu,
  limit,
  compactActions = false,
  overflowLabel = 'archived task',
  actionLabel,
  actionDisabled = false,
  actionIcon,
  onAction,
}: {
  label: string;
  tasks: TaskPoolTask[];
  open: boolean;
  onToggle: () => void;
  activeSessionKey?: string | null;
  onSelectSession?: (sessionKey: string) => void;
  onOpenMenu?: (task: TaskPoolTask, x: number, y: number) => void;
  limit?: number;
  compactActions?: boolean;
  overflowLabel?: string;
  actionLabel?: string;
  actionDisabled?: boolean;
  actionIcon?: ReactNode;
  onAction?: () => void;
}) {
  const visibleTasks = typeof limit === 'number' ? tasks.slice(0, limit) : tasks;
  const overflow = tasks.length - visibleTasks.length;

  return (
    <div>
      <div
        style={{
          width: '100%',
          minHeight: 32,
          marginTop: 12,
          borderWidth: 0,
          borderTopWidth: 1,
          borderTopStyle: 'solid',
          borderTopColor: 'var(--t-divider-subtle)',
          background: 'transparent',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          paddingTop: 6,
          paddingBottom: 2,
        }}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 24,
            border: 0,
            background: 'transparent',
            color: 'var(--t-text-faint)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: 0,
            textAlign: 'left',
            fontFamily: REPO_FOCUS_FONT,
            fontSize: 10,
            lineHeight: '13px',
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            transition: 'color 140ms ease',
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--t-text-muted)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--t-text-faint)'; }}
        >
          <ChevronDown
            size={11}
            strokeWidth={2}
            style={{
              flexShrink: 0,
              transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
              transition: 'transform 140ms ease',
            }}
          />
          <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
          <span style={{ fontSize: 9.5, lineHeight: '12px', letterSpacing: 0, fontWeight: 500 }}>
            {tasks.length}
          </span>
        </button>
        {onAction ? (
          <button
            type="button"
            aria-label={actionLabel}
            title={actionLabel}
            disabled={actionDisabled}
            onClick={(event) => {
              event.stopPropagation();
              if (!actionDisabled) onAction();
            }}
            style={{
              width: 22,
              height: 22,
              border: 0,
              borderRadius: 7,
              background: 'transparent',
              color: actionDisabled ? 'var(--t-text-faint)' : 'var(--t-text-muted)',
              cursor: actionDisabled ? 'default' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
            }}
          >
            {actionIcon}
          </button>
        ) : null}
      </div>
      {open ? (
        <>
          {visibleTasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              active={Boolean(task.lane?.sessionKey && task.lane.sessionKey === activeSessionKey)}
              onSelectSession={onSelectSession}
              onOpenMenu={onOpenMenu}
              compactActions={compactActions}
            />
          ))}
          {overflow > 0 ? (
            <div style={{ paddingTop: 6, paddingBottom: 2, color: 'var(--t-text-faint)', fontSize: 10.5, lineHeight: '14px' }}>
              + {overflow} more {overflowLabel}{overflow === 1 ? '' : 's'}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function TaskRow({
  task,
  active,
  onSelectSession,
  onOpenMenu,
  compactActions = false,
}: {
  task: TaskPoolTask;
  active: boolean;
  onSelectSession?: (sessionKey: string) => void;
  onOpenMenu?: (task: TaskPoolTask, x: number, y: number) => void;
  compactActions?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const tone = GROUP_TONES[task.group] ?? GROUP_TONES.ready;
  const sessionKey = task.lane?.sessionKey ?? null;
  const selectedRuntime = task.workerRouting?.selectedRuntime ?? task.runtime;
  const taskIntent = task.workerRouting?.workerIntent ?? task.workerIntent;
  const requestedProvider = task.workerRouting?.requestedProvider;
  const repoLabel = (task.repoName ?? baseName(task.repoPath)) || 'repo';
  const detail = taskSignal(task) || task.summary;
  const stale = isStaleTask(task);
  const metaParts = [
    repoLabel,
    `${intentLabel(taskIntent)} - ${runtimeLabel(selectedRuntime)}`,
    taskTimeLabel(task),
  ].filter(Boolean);
  const showActions = compactActions || hovered || active;

  return (
    <div
      role="button"
      tabIndex={sessionKey ? 0 : -1}
      aria-disabled={!sessionKey}
      onClick={() => {
        if (sessionKey) onSelectSession?.(sessionKey);
      }}
      onKeyDown={(event) => {
        if (!sessionKey) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelectSession?.(sessionKey);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu?.(task, event.clientX, event.clientY);
      }}
      style={{
        width: '100%',
        minHeight: compactActions ? 43 : 49,
        borderWidth: 0,
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        background: active ? 'color-mix(in srgb, var(--t-accent) 6%, transparent)' : hovered ? FLAT_HOVER_SURFACE : 'transparent',
        color: 'var(--t-text)',
        cursor: sessionKey ? 'pointer' : 'default',
        display: 'flex',
        alignItems: 'center',
        gap: compactActions ? 7 : 8,
        paddingTop: compactActions ? 5 : 6,
        paddingRight: 0,
        paddingBottom: compactActions ? 5 : 6,
        paddingLeft: 0,
        textAlign: 'left',
        outline: 'none',
        fontFamily: REPO_FOCUS_FONT,
        transition: 'background 140ms ease',
      } as CSSProperties}
    >
      <span
        aria-hidden
        style={{
          width: 20,
          height: 20,
          flexShrink: 0,
          borderRadius: 6,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: tone.text,
          background: active ? tone.soft : 'transparent',
        }}
      >
        <RuntimeIcon runtime={selectedRuntime} size={14} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          className={active ? 'o8-text-shimmer' : undefined}
          style={{
            display: 'block',
            fontSize: compactActions ? 11.5 : 12,
            lineHeight: compactActions ? '15px' : '16px',
            fontWeight: active ? 600 : 520,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            ...(active ? shimmerTextStyle('var(--t-text)', 'var(--t-accent)') : {}),
          }}
        >
          {task.title}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 1,
            color: 'var(--t-text-faint)',
            fontSize: compactActions ? 9.75 : 10.25,
            lineHeight: compactActions ? '12px' : '13px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {metaParts.join(' - ')}
          {requestedProvider && requestedProvider !== 'codex' ? ` - requested ${requestedProvider}` : ''}
        </span>
        {detail ? (
          <span
            style={{
              display: 'block',
            marginTop: 2,
            color: task.group === 'blocked' ? '#dc2626' : 'var(--t-text-muted)',
            fontSize: compactActions ? 9.75 : 10.25,
            lineHeight: compactActions ? '12px' : '13px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
          {detail}
          </span>
        ) : null}
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: compactActions ? 2 : 4, flexShrink: 0 }}>
        <span
          style={{
            minHeight: compactActions ? 18 : 20,
            display: 'inline-flex',
            alignItems: 'center',
            borderRadius: 7,
            borderWidth: task.group === 'ready' && !stale ? 0 : 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider-subtle)',
            background: stale ? 'color-mix(in srgb, var(--t-text-faint) 8%, transparent)' : task.group === 'ready' ? 'transparent' : tone.soft,
            color: stale ? 'var(--t-text-faint)' : tone.text,
            paddingTop: 0,
            paddingRight: task.group === 'ready' && !stale ? 0 : compactActions ? 5 : 6,
            paddingBottom: 0,
            paddingLeft: task.group === 'ready' && !stale ? 0 : compactActions ? 5 : 6,
            fontSize: compactActions ? 9.25 : 9.75,
            lineHeight: '12px',
            fontWeight: 580,
            flexShrink: 0,
          }}
        >
          {stale ? 'Stale' : GROUP_LABELS[task.group]}
        </span>
        {sessionKey ? (
          <TaskIconButton
            label={`Open ${task.title}`}
            visible={showActions}
            active={active}
            onClick={(event) => {
              event.stopPropagation();
              onSelectSession?.(sessionKey);
            }}
          >
            <ExternalLink size={12} strokeWidth={2} />
          </TaskIconButton>
        ) : null}
        <TaskIconButton
          label={`Actions for ${task.title}`}
          visible={showActions}
          active={active}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenMenu?.(task, rect.right - 8, rect.bottom + 5);
          }}
        >
          <MoreHorizontal size={13} strokeWidth={2.1} />
        </TaskIconButton>
      </span>
    </div>
  );
}

function TaskIconButton({
  label,
  visible,
  active,
  children,
  onClick,
}: {
  label: string;
  visible: boolean;
  active: boolean;
  children: ReactNode;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 20,
        height: 20,
        border: 0,
        borderRadius: 7,
        background: hovered ? FLAT_HOVER_SURFACE : 'transparent',
        color: hovered || active ? 'var(--t-text-muted)' : 'var(--t-text-faint)',
        cursor: 'pointer',
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        transition: 'opacity 120ms ease, color 120ms ease, background 120ms ease',
      }}
    >
      {children}
    </button>
  );
}

function TaskActionMenu({
  state,
  busyKey,
  onClose,
  onSelectSession,
  onAction,
}: {
  state: TaskActionMenuState;
  busyKey: string | null;
  onClose: () => void;
  onSelectSession?: (sessionKey: string) => void;
  onAction: (task: TaskPoolTask, action: TaskAction, body?: Record<string, unknown>) => void;
}) {
  const [mode, setMode] = useState<'menu' | 'block' | 'report'>('menu');
  const [detail, setDetail] = useState('');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const task = state.task;
  const busy = busyKey?.endsWith(`:${task.id}`) ?? false;
  const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
  const menuWidth = 248;
  const menuHeight = mode === 'menu' ? 266 : 214;
  const panelRect = typeof document === 'undefined'
    ? null
    : document.querySelector('[data-o8-agent-panel="true"]')?.getBoundingClientRect() ?? null;
  const boundaryLeft = panelRect?.left ?? 0;
  const boundaryRight = panelRect?.right ?? viewportWidth;
  const boundaryTop = panelRect?.top ?? 0;
  const boundaryBottom = panelRect?.bottom ?? viewportHeight;
  const minLeft = boundaryLeft + 8;
  const maxLeft = Math.max(minLeft, boundaryRight - menuWidth - 8);
  const desiredLeft = state.x + menuWidth > boundaryRight - 8 ? state.x - menuWidth + 18 : state.x;
  const left = Math.min(Math.max(desiredLeft, minLeft), maxLeft);
  const minTop = boundaryTop + 8;
  const maxTop = Math.max(minTop, boundaryBottom - menuHeight - 8);
  const top = Math.min(Math.max(state.y, minTop), maxTop);
  const sessionKey = task.lane?.sessionKey ?? null;
  const taskIsDone = task.group === 'done';

  return (
    <>
      <button
        type="button"
        aria-label="Close task action menu"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 48,
          border: 0,
          background: 'transparent',
          cursor: 'default',
        }}
      />
      <div
        data-o8-task-action-menu="true"
        style={{
          position: 'fixed',
          left,
          top,
          zIndex: 49,
          width: 248,
          borderRadius: 16,
          border: '1px solid var(--t-divider-subtle)',
          background: FLOATING_GLASS_SURFACE,
          boxShadow: '0 22px 64px rgba(15, 23, 42, 0.14)',
          backdropFilter: 'blur(20px) saturate(145%)',
          WebkitBackdropFilter: 'blur(20px) saturate(145%)',
          padding: 8,
          color: 'var(--t-text)',
          fontFamily: REPO_FOCUS_FONT,
        }}
      >
        <div style={{ padding: '5px 6px 8px' }}>
          <div style={{ fontSize: 11.5, lineHeight: '15px', fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {task.title}
          </div>
          <div style={{ marginTop: 1, color: 'var(--t-text-faint)', fontSize: 10.25, lineHeight: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {task.repoName ?? baseName(task.repoPath)} - {GROUP_LABELS[task.group]} - {runtimeLabel(task.workerRouting?.selectedRuntime ?? task.runtime)}
          </div>
        </div>

        {mode === 'menu' ? (
          <div style={{ display: 'grid', gap: 3 }}>
            <MenuActionRow
              label="Open session"
              disabled={!sessionKey}
              onClick={() => {
                if (sessionKey) onSelectSession?.(sessionKey);
                onClose();
              }}
            />
            <MenuActionRow
              label="Claim"
              disabled={busy}
              onClick={() => onAction(task, 'claim', { note: 'Claimed from Control Room.' })}
            />
            <MenuActionRow
              label="Dispatch"
              disabled={busy}
              primary
              onClick={() => onAction(task, 'dispatch', { message: 'Dispatched from Control Room.' })}
            />
            <MenuActionRow
              label="Report progress..."
              disabled={busy}
              onClick={() => setMode('report')}
            />
            <MenuActionRow
              label="Block..."
              disabled={busy}
              danger
              onClick={() => setMode('block')}
            />
            <MenuActionRow
              label={taskIsDone ? 'Prune permanently' : 'Prune / archive'}
              disabled={busy}
              danger={taskIsDone}
              onClick={() => onAction(
                task,
                taskIsDone ? 'prune' : 'archive',
                { reason: taskIsDone ? 'Pruned from Control Room.' : 'Archived from Control Room.' },
              )}
            />
          </div>
        ) : (
          <div style={{ padding: '2px 4px 4px' }}>
            <textarea
              value={detail}
              onChange={(event) => setDetail(event.currentTarget.value)}
              rows={3}
              placeholder={mode === 'block' ? 'Why is it blocked?' : 'What changed?'}
              style={{
                width: '100%',
                minHeight: 62,
                resize: 'vertical',
                border: '1px solid var(--t-divider-subtle)',
                borderRadius: 11,
                background: FIELD_SURFACE,
                color: 'var(--t-text)',
                outline: 'none',
                padding: 8,
                fontFamily: REPO_FOCUS_FONT,
                fontSize: 11.25,
                lineHeight: '15px',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 7 }}>
              <ActionButton label="Back" disabled={busy} onClick={() => setMode('menu')} />
              <ActionButton
                label={mode === 'block' ? 'Block' : 'Report'}
                primary={mode === 'report'}
                disabled={busy || !detail.trim()}
                onClick={() => {
                  const message = detail.trim();
                  if (!message) return;
                  if (mode === 'block') {
                    onAction(task, 'block', { reason: message, code: 'needs_clarification' });
                  } else {
                    onAction(task, 'report', { event: 'progress', message });
                  }
                }}
              />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function MenuActionRow({
  label,
  primary = false,
  danger = false,
  disabled = false,
  onClick,
}: {
  label: string;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%',
        minHeight: 30,
        borderRadius: 10,
        border: 0,
        background: hovered && !disabled ? FLAT_HOVER_SURFACE : 'transparent',
        color: disabled
          ? 'var(--t-text-faint)'
          : danger
            ? '#dc2626'
            : primary
              ? 'var(--t-accent)'
              : 'var(--t-text-muted)',
        cursor: disabled ? 'default' : 'pointer',
        textAlign: 'left',
        paddingTop: 0,
        paddingRight: 9,
        paddingBottom: 0,
        paddingLeft: 9,
        fontFamily: REPO_FOCUS_FONT,
        fontSize: 11.25,
        lineHeight: '15px',
        fontWeight: primary ? 650 : 560,
        transition: 'background 140ms ease, color 140ms ease',
      }}
    >
      {label}
    </button>
  );
}

function StatusMessage({
  icon,
  tone,
  title,
  body,
}: {
  icon: ReactNode;
  tone: string;
  title: string;
  body: string;
}) {
  return (
    <div
      style={{
        marginTop: 18,
        display: 'flex',
        gap: 9,
        color: 'var(--t-text-muted)',
      }}
    >
      <span style={{ width: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: tone, flexShrink: 0 }}>
        {icon}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', color: 'var(--t-text)', fontSize: 12, lineHeight: '16px', fontWeight: 600 }}>
          {title}
        </span>
        <span style={{ display: 'block', marginTop: 2, fontSize: 11, lineHeight: '15px', color: 'var(--t-text-faint)' }}>
          {body}
        </span>
      </span>
    </div>
  );
}

function shimmerTextStyle(base = 'var(--t-text)', flare = 'var(--t-accent)'): CSSProperties {
  return {
    backgroundImage: `linear-gradient(110deg, ${base} 0%, ${base} 34%, ${flare} 50%, ${base} 66%, ${base} 100%)`,
    backgroundSize: '220% 100%',
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
    WebkitTextFillColor: 'transparent',
    animation: 'o8-text-shimmer 2.35s linear infinite',
  };
}
