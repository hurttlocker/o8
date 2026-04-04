'use client';
/* eslint-disable @typescript-eslint/no-unused-vars, react-hooks/exhaustive-deps -- extracted from Canvas.tsx */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  GitMerge,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Send,
  X,
  XCircle,
} from 'lucide-react';
import { MarkdownBody } from './MarkdownBody';
import {
  formatCiCheckBatchInjection,
  formatCiCheckInjection,
  formatReviewCommentBatchInjection,
  formatReviewCommentInjection,
  formatReviewThreadInjection,
  type AgentPanelChatInjectionPayload,
} from '@/lib/chat/injection';
import type { RepoReadiness, RepoRegistryEntry } from '@/lib/repos/types';
import { deriveWorkflowStage, describeWorkflowStage, type WorkflowStageBadge } from '@/lib/workflows/status';
import { repoSlugFromRemote, readinessTone, formatAge, LIGHT_CANVAS_VARS } from './canvas-utils';
import { renderDiffLines } from './diff-utils';

interface PRDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  author: { login: string };
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  mergedBy: { login: string } | null;
  labels: { name: string; color: string }[];
  reviews: { author: { login: string }; state: string; body: string }[];
  files: { path: string; additions: number; deletions: number }[];
  statusCheckRollup: {
    name: string;
    status: string;
    conclusion: string;
    detailsUrl?: string;
    startedAt?: string;
    completedAt?: string;
  }[];
  reviewComments: { id: number; body: string; user: string; path: string; line: number | null; created_at: string }[];
  issueComments: { id: number; body: string; user: string; created_at: string }[];
  diffStat: string;
  url: string;
  readiness?: RepoReadiness | null;
  workflowStage?: WorkflowStageBadge | null;
}

type ReviewThreadStatus = 'active' | 'outdated' | 'resolved';

interface ReviewThreadComment {
  id: string;
  databaseId: number | null;
  author: string;
  body: string;
  createdAt: string;
  diffHunk: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  url: string;
  isOptimistic?: boolean;
}

interface ReviewThread {
  id: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  originalStartLine: number | null;
  diffSide: string;
  startDiffSide: string | null;
  isResolved: boolean;
  isOutdated: boolean;
  isCollapsed: boolean;
  status: ReviewThreadStatus;
  subjectType: string;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  resolvedBy: string | null;
  latestCommentAt: string;
  comments: ReviewThreadComment[];
}

interface PersistedReviewThreadUiState {
  viewed: string[];
  collapsed: string[];
}

class ReviewThreadClientError extends Error {
  readonly status: number | null;

  constructor(message: string, status?: number | null) {
    super(message);
    this.name = 'ReviewThreadClientError';
    this.status = status ?? null;
  }
}

const REVIEW_THREAD_STORAGE_VERSION = 1;
const REVIEW_THREAD_CLIENT_RETRY_DELAYS_MS = [250, 700];

function deriveReviewThreadStatus(thread: { isResolved: boolean; isOutdated: boolean }): ReviewThreadStatus {
  if (thread.isResolved) return 'resolved';
  if (thread.isOutdated) return 'outdated';
  return 'active';
}

function normalizeReviewThread(thread: ReviewThread): ReviewThread {
  const comments = [...thread.comments].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  const latestCommentAt = comments[comments.length - 1]?.createdAt ?? thread.latestCommentAt ?? '';
  return {
    ...thread,
    line: typeof thread.line === 'number' ? thread.line : null,
    originalLine: typeof thread.originalLine === 'number' ? thread.originalLine : null,
    startLine: typeof thread.startLine === 'number' ? thread.startLine : null,
    originalStartLine: typeof thread.originalStartLine === 'number' ? thread.originalStartLine : null,
    diffSide: thread.diffSide || 'RIGHT',
    startDiffSide: thread.startDiffSide ?? null,
    isResolved: Boolean(thread.isResolved),
    isOutdated: Boolean(thread.isOutdated),
    isCollapsed: Boolean(thread.isCollapsed),
    status: deriveReviewThreadStatus(thread),
    subjectType: thread.subjectType || 'LINE',
    viewerCanReply: Boolean(thread.viewerCanReply),
    viewerCanResolve: Boolean(thread.viewerCanResolve),
    viewerCanUnresolve: Boolean(thread.viewerCanUnresolve),
    resolvedBy: thread.resolvedBy ?? null,
    latestCommentAt,
    comments,
  };
}

function normalizeReviewThreads(threads: ReviewThread[]) {
  return threads
    .map(normalizeReviewThread)
    .sort((left, right) => new Date(right.latestCommentAt).getTime() - new Date(left.latestCommentAt).getTime());
}

function buildReviewThreadStorageKey(repo: string | undefined, prNumber: number) {
  return `cortex.pr-review-thread-ui.v${REVIEW_THREAD_STORAGE_VERSION}:${repo ?? 'unknown'}:${prNumber}`;
}

function readPersistedReviewThreadUiState(storageKey: string): PersistedReviewThreadUiState {
  if (typeof window === 'undefined') {
    return { viewed: [], collapsed: [] };
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return { viewed: [], collapsed: [] };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedReviewThreadUiState>;
    return {
      viewed: Array.isArray(parsed.viewed) ? parsed.viewed.filter((value): value is string => typeof value === 'string') : [],
      collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed.filter((value): value is string => typeof value === 'string') : [],
    };
  } catch {
    return { viewed: [], collapsed: [] };
  }
}

function toThreadPreferenceMap(ids: string[]) {
  return ids.reduce<Record<string, true>>((accumulator, id) => {
    accumulator[id] = true;
    return accumulator;
  }, {});
}

function isRetryableReviewThreadError(error: unknown) {
  if (error instanceof ReviewThreadClientError) {
    return error.status === 429 || (error.status !== null && error.status >= 500);
  }

  if (!(error instanceof Error)) return false;
  return /failed to fetch|network|timeout|timed out/i.test(error.message);
}

async function waitForReviewThreadRetry(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestReviewThreadApi<T extends Record<string, unknown>>(url: string, init?: RequestInit) {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= REVIEW_THREAD_CLIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetch(url, init);
      const payload = await response.json().catch(() => ({})) as { error?: string } & T;
      if (!response.ok) {
        const message = payload.error?.trim() || `HTTP ${response.status}`;
        if (response.status === 429 || response.status >= 500) {
          throw new ReviewThreadClientError(message, response.status);
        }
        throw new Error(message);
      }
      return payload;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error('Review thread request failed');
      lastError = normalized;
      if (attempt >= REVIEW_THREAD_CLIENT_RETRY_DELAYS_MS.length || !isRetryableReviewThreadError(normalized)) {
        throw normalized;
      }
      await waitForReviewThreadRetry(REVIEW_THREAD_CLIENT_RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError ?? new Error('Review thread request failed');
}

function formatReviewThreadLocation(thread: ReviewThread) {
  if (thread.startLine && thread.line && thread.startLine !== thread.line) {
    return `${thread.startLine}-${thread.line}`;
  }
  if (thread.line) {
    return `${thread.line}`;
  }
  if (thread.originalStartLine && thread.originalLine && thread.originalStartLine !== thread.originalLine) {
    return `${thread.originalStartLine}-${thread.originalLine}`;
  }
  if (thread.originalLine) {
    return `${thread.originalLine}`;
  }
  return null;
}

function reviewThreadTone(status: ReviewThreadStatus) {
  if (status === 'resolved') {
    return {
      label: 'Resolved',
      color: '#15803d',
      accent: 'rgba(22, 163, 74, 0.7)',
      border: 'rgba(22, 163, 74, 0.18)',
      background: 'linear-gradient(180deg, rgba(255,255,255,0.82), rgba(220,252,231,0.58))',
      pillBackground: 'rgba(22,163,74,0.12)',
      pillBorder: 'rgba(22,163,74,0.18)',
      summaryDecoration: 'line-through',
    };
  }

  if (status === 'outdated') {
    return {
      label: 'Outdated',
      color: '#64748b',
      accent: 'rgba(100, 116, 139, 0.55)',
      border: 'rgba(148, 163, 184, 0.22)',
      background: 'linear-gradient(180deg, rgba(255,255,255,0.76), rgba(226,232,240,0.54))',
      pillBackground: 'rgba(148,163,184,0.14)',
      pillBorder: 'rgba(148,163,184,0.22)',
      summaryDecoration: 'none',
    };
  }

  return {
    label: 'Active',
    color: '#1d4ed8',
    accent: 'rgba(37, 99, 235, 0.72)',
    border: 'rgba(96, 165, 250, 0.22)',
    background: 'linear-gradient(180deg, rgba(255,255,255,0.84), rgba(219,234,254,0.54))',
    pillBackground: 'rgba(37,99,235,0.12)',
    pillBorder: 'rgba(37,99,235,0.18)',
    summaryDecoration: 'none',
  };
}

function normalizePRDetail(pr: PRDetail): PRDetail {
  return {
    ...pr,
    labels: Array.isArray(pr.labels) ? pr.labels : [],
    reviews: Array.isArray(pr.reviews) ? pr.reviews : [],
    files: Array.isArray(pr.files) ? pr.files : [],
    statusCheckRollup: Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [],
    reviewComments: Array.isArray(pr.reviewComments) ? pr.reviewComments : [],
    issueComments: Array.isArray(pr.issueComments) ? pr.issueComments : [],
  };
}

const prStateStyles: Record<string, { color: string; label: string; bg: string }> = {
  OPEN: { color: '#22c55e', label: 'Open', bg: 'rgba(34,197,94,0.08)' },
  MERGED: { color: '#8b5cf6', label: 'Merged', bg: 'rgba(139,92,246,0.08)' },
  CLOSED: { color: '#ef4444', label: 'Closed', bg: 'rgba(239,68,68,0.08)' },
};

function createDesktopGlassActionStyle(variant: 'primary' | 'muted' = 'primary') {
  const isPrimary = variant === 'primary';
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    minHeight: 0,
    paddingTop: 4,
    paddingRight: 8,
    paddingBottom: 4,
    paddingLeft: 8,
    borderRadius: 6,
    border: `1px solid ${isPrimary ? '#dbeafe' : '#e5e7eb'}`,
    background: isPrimary ? '#eff6ff' : '#f9fafb',
    boxShadow: 'none',
    color: isPrimary ? '#2563eb' : '#6b7280',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: '-apple-system, system-ui, sans-serif',
  } as React.CSSProperties;
}

function DesktopGlassActionChip({
  icon,
  label,
  onClick,
  variant = 'primary',
  disabled = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'muted';
  disabled?: boolean;
}) {
  const style = createDesktopGlassActionStyle(variant);

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      style={{
        ...style,
        opacity: disabled ? 0.62 : 1,
        cursor: disabled ? 'default' : style.cursor,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

export function PRViewer({
  prNumber,
  repo,
  onInjectChatContext,
}: {
  prNumber: number;
  repo?: string;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload) => void;
}) {
  const [pr, setPr] = useState<PRDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [activeSection, setActiveSection] = useState<'overview' | 'files' | 'checks' | 'comments' | 'reviews'>('overview');
  const [activeItemIndex, setActiveItemIndex] = useState(0);
  const [reviewThreads, setReviewThreads] = useState<ReviewThread[]>([]);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [reviewThreadsError, setReviewThreadsError] = useState<string | null>(null);
  const [reviewThreadsLoaded, setReviewThreadsLoaded] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [threadActionLoading, setThreadActionLoading] = useState<Record<string, 'reply' | 'resolve' | 'unresolve'>>({});
  const [viewedThreadIds, setViewedThreadIds] = useState<Record<string, true>>({});
  const [collapsedThreadIds, setCollapsedThreadIds] = useState<Record<string, true>>({});
  const [hydratedReviewThreadStorageKey, setHydratedReviewThreadStorageKey] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [addedContextKeys, setAddedContextKeys] = useState<Record<string, true>>({});
  const [hiddenCommentKeys, setHiddenCommentKeys] = useState<Record<string, true>>({});
  const [hoveredCommentKey, setHoveredCommentKey] = useState<string | null>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);
  const [localRepo, setLocalRepo] = useState<Pick<RepoRegistryEntry, 'name' | 'localPath' | 'readiness'> | null>(null);
  const reviewThreadStorageKey = useMemo(() => buildReviewThreadStorageKey(repo, prNumber), [repo, prNumber]);

  const submitAction = useCallback(async (action: string, comment?: string) => {
    setActionLoading(action);
    setActionResult(null);
    try {
      const res = await fetch(`/api/panel/prs/${prNumber}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, repo, comment }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      const labels: Record<string, string> = {
        approved: 'PR approved',
        changes_requested: 'Changes requested',
        commented: 'Comment posted',
        merged: 'PR merged',
        closed: 'PR closed',
      };
      setActionResult({ type: 'success', message: labels[data.action] || 'Done' });
      setCommentText('');
      // Refresh PR data
      const repoParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
      const fresh = await fetch(`/api/panel/prs/${prNumber}${repoParam}`);
      if (fresh.ok) {
        const freshData = await fresh.json();
        setPr(normalizePRDetail(freshData.pr));
      }
    } catch (err) {
      setActionResult({ type: 'error', message: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setActionLoading(null);
    }
  }, [prNumber, repo]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setActionResult(null);
    setReviewThreads([]);
    setReviewThreadsError(null);
    setReviewThreadsLoaded(false);
    setReplyDrafts({});
    setThreadActionLoading({});

    const repoParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    fetch(`/api/panel/prs/${prNumber}${repoParam}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!cancelled) {
          setPr(normalizePRDetail(data.pr));
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [prNumber, repo, reloadNonce]);

  useEffect(() => {
    if (!repo) {
      setLocalRepo(null);
      return;
    }
    let cancelled = false;
    fetch('/api/panel/repos')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const match = (data.repos ?? []).find((entry: RepoRegistryEntry) => repoSlugFromRemote(entry.remoteUrl) === repo);
        setLocalRepo(match ? { name: match.name, localPath: match.localPath, readiness: match.readiness } : null);
      })
      .catch(() => {
        if (!cancelled) setLocalRepo(null);
      });
    return () => { cancelled = true; };
  }, [repo]);

  useEffect(() => {
    const persisted = readPersistedReviewThreadUiState(reviewThreadStorageKey);
    setViewedThreadIds(toThreadPreferenceMap(persisted.viewed));
    setCollapsedThreadIds(toThreadPreferenceMap(persisted.collapsed));
    setHydratedReviewThreadStorageKey(reviewThreadStorageKey);
  }, [reviewThreadStorageKey]);

  useEffect(() => {
    if (hydratedReviewThreadStorageKey !== reviewThreadStorageKey || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(reviewThreadStorageKey, JSON.stringify({
        viewed: Object.keys(viewedThreadIds),
        collapsed: Object.keys(collapsedThreadIds),
      } satisfies PersistedReviewThreadUiState));
    } catch {
      // Ignore local persistence failures for thread UI preferences.
    }
  }, [collapsedThreadIds, hydratedReviewThreadStorageKey, reviewThreadStorageKey, viewedThreadIds]);

  const fetchReviewThreads = useCallback(async () => {
    setReviewsLoading(true);
    setReviewThreadsError(null);
    const repoParam = repo ? `&repo=${encodeURIComponent(repo)}` : '';

    try {
      const data = await requestReviewThreadApi<{ threads?: ReviewThread[] }>(
        `/api/panel/pr/review/threads?number=${prNumber}${repoParam}`,
      );
      const normalizedThreads = normalizeReviewThreads(Array.isArray(data.threads) ? data.threads : []);
      setReviewThreads(normalizedThreads);
      setReviewThreadsLoaded(true);
      return normalizedThreads;
    } catch (error) {
      setReviewThreadsLoaded(true);
      setReviewThreadsError(error instanceof Error ? error.message : 'Failed to load review threads');
      throw error;
    } finally {
      setReviewsLoading(false);
    }
  }, [prNumber, repo]);

  useEffect(() => {
    if (activeSection !== 'reviews' || reviewThreadsLoaded) return;
    let cancelled = false;
    void fetchReviewThreads().catch((error) => {
      if (cancelled) return;
      setReviewThreadsError(error instanceof Error ? error.message : 'Failed to load review threads');
    });
    return () => { cancelled = true; };
  }, [activeSection, fetchReviewThreads, reviewThreadsLoaded]);

  const toggleViewedThread = useCallback((threadId: string) => {
    setViewedThreadIds((current) => {
      if (current[threadId]) {
        const next = { ...current };
        delete next[threadId];
        return next;
      }
      return { ...current, [threadId]: true };
    });
  }, []);

  const toggleCollapsedThread = useCallback((threadId: string) => {
    setCollapsedThreadIds((current) => {
      if (current[threadId]) {
        const next = { ...current };
        delete next[threadId];
        return next;
      }
      return { ...current, [threadId]: true };
    });
  }, []);

  const submitThreadReply = useCallback(async (threadId: string) => {
    const thread = reviewThreads.find((candidate) => candidate.id === threadId);
    const draft = replyDrafts[threadId]?.trim() ?? '';

    if (!thread || !draft) return;

    const optimisticComment: ReviewThreadComment = {
      id: `optimistic-${threadId}-${Date.now()}`,
      databaseId: null,
      author: 'You',
      body: draft,
      createdAt: new Date().toISOString(),
      diffHunk: '',
      path: thread.path,
      line: thread.line,
      originalLine: thread.originalLine,
      url: '',
      isOptimistic: true,
    };
    const previousThread = thread;
    const optimisticThread = normalizeReviewThread({
      ...thread,
      latestCommentAt: optimisticComment.createdAt,
      comments: [...thread.comments, optimisticComment],
    });

    setThreadActionLoading((current) => ({ ...current, [threadId]: 'reply' }));
    setReviewThreads((current) => current.map((candidate) => candidate.id === threadId ? optimisticThread : candidate));
    setReplyDrafts((current) => ({ ...current, [threadId]: '' }));
    setViewedThreadIds((current) => ({ ...current, [threadId]: true }));
    setReviewThreadsError(null);

    try {
      const data = await requestReviewThreadApi<{ thread?: ReviewThread | null; threads?: ReviewThread[] }>(
        '/api/panel/pr/review/reply',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo, number: prNumber, threadId, comment: draft }),
        },
      );
      const nextThreads = Array.isArray(data.threads)
        ? normalizeReviewThreads(data.threads)
        : null;
      if (nextThreads) {
        setReviewThreads(nextThreads);
      } else if (data.thread) {
        const normalizedThread = normalizeReviewThread(data.thread);
        setReviewThreads((current) => current.map((candidate) => candidate.id === threadId ? normalizedThread : candidate));
      }
      setActionResult({ type: 'success', message: 'Reply posted' });
    } catch (error) {
      setReviewThreads((current) => current.map((candidate) => candidate.id === threadId ? previousThread : candidate));
      setReplyDrafts((current) => ({ ...current, [threadId]: draft }));
      setActionResult({ type: 'error', message: error instanceof Error ? error.message : 'Failed to reply to review thread' });
    } finally {
      setThreadActionLoading((current) => {
        const next = { ...current };
        delete next[threadId];
        return next;
      });
    }
  }, [prNumber, replyDrafts, repo, reviewThreads]);

  const submitThreadResolve = useCallback(async (threadId: string, resolved: boolean) => {
    const thread = reviewThreads.find((candidate) => candidate.id === threadId);
    if (!thread) return;

    const previousThread = thread;
    const optimisticThread = normalizeReviewThread({
      ...thread,
      isResolved: resolved,
      status: resolved ? 'resolved' : (thread.isOutdated ? 'outdated' : 'active'),
    });

    setThreadActionLoading((current) => ({ ...current, [threadId]: resolved ? 'resolve' : 'unresolve' }));
    setReviewThreads((current) => current.map((candidate) => candidate.id === threadId ? optimisticThread : candidate));
    setViewedThreadIds((current) => ({ ...current, [threadId]: true }));
    setReviewThreadsError(null);

    try {
      const data = await requestReviewThreadApi<{ thread?: ReviewThread | null; threads?: ReviewThread[] }>(
        '/api/panel/pr/review/resolve',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo, number: prNumber, threadId, resolved }),
        },
      );
      if (Array.isArray(data.threads)) {
        setReviewThreads(normalizeReviewThreads(data.threads));
      } else if (data.thread) {
        const normalizedThread = normalizeReviewThread(data.thread);
        setReviewThreads((current) => current.map((candidate) => candidate.id === threadId ? normalizedThread : candidate));
      }
      setActionResult({ type: 'success', message: resolved ? 'Thread resolved' : 'Thread reopened' });
    } catch (error) {
      setReviewThreads((current) => current.map((candidate) => candidate.id === threadId ? previousThread : candidate));
      setActionResult({ type: 'error', message: error instanceof Error ? error.message : 'Failed to update thread state' });
    } finally {
      setThreadActionLoading((current) => {
        const next = { ...current };
        delete next[threadId];
        return next;
      });
    }
  }, [prNumber, repo, reviewThreads]);

  const injectPayload = useCallback((key: string, payload: AgentPanelChatInjectionPayload) => {
    if (!onInjectChatContext) return;
    onInjectChatContext(payload);
    setAddedContextKeys((current) => ({ ...current, [key]: true }));
  }, [onInjectChatContext]);

  const hideComment = useCallback((key: string) => {
    setHiddenCommentKeys((current) => ({ ...current, [key]: true }));
  }, []);

  const focusCommentComposer = useCallback(() => {
    setActiveSection('comments');
    requestAnimationFrame(() => {
      commentInputRef.current?.focus();
      commentInputRef.current?.select();
    });
  }, []);

  const openPullRequestOnGitHub = useCallback(() => {
    if (!repo) return;
    window.open(`https://github.com/${repo}/pull/${prNumber}`, '_blank', 'noopener,noreferrer');
  }, [prNumber, repo]);
  const checkContextKey = useCallback((name?: string | null) => `check:${name ?? 'unknown'}`, []);

  const currentChecks = pr?.statusCheckRollup ?? [];
  const currentAllComments = pr
    ? [
        ...pr.issueComments.map((comment) => ({ ...comment, kind: 'comment' as const })),
        ...pr.reviewComments.map((comment) => ({ ...comment, kind: 'review' as const })),
      ].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    : [];
  const currentVisibleComments = currentAllComments.filter((comment) => !hiddenCommentKeys[`${comment.kind}:${comment.id}`]);
  const currentVisibleReviewThreads = reviewThreads;
  const activeSectionItemCount = activeSection === 'files'
    ? (pr?.files?.length ?? 0)
    : activeSection === 'checks'
      ? currentChecks.length
      : activeSection === 'comments'
        ? currentVisibleComments.length
        : activeSection === 'reviews'
          ? currentVisibleReviewThreads.length
          : 0;

  useEffect(() => {
    setActiveItemIndex(0);
  }, [activeSection]);

  useEffect(() => {
    setActiveItemIndex((current) => Math.min(current, Math.max(0, activeSectionItemCount - 1)));
  }, [activeSectionItemCount]);

  useEffect(() => {
    if (activeSection === 'overview' || activeSectionItemCount === 0) return undefined;

    const frame = requestAnimationFrame(() => {
      const target = document.querySelector(
        `[data-pr-section="${activeSection}"][data-pr-index="${activeItemIndex}"]`,
      ) as HTMLElement | null;
      target?.scrollIntoView({ block: 'nearest' });
    });

    return () => cancelAnimationFrame(frame);
  }, [activeItemIndex, activeSection, activeSectionItemCount]);

  const runSelectedItemAction = useCallback(async () => {
    if (!pr) return;

    if (activeSection === 'files') {
      const selectedFile = pr.files?.[activeItemIndex];
      if (!selectedFile) return;
      await navigator.clipboard.writeText(selectedFile.path);
      setActionResult({ type: 'success', message: `Copied ${selectedFile.path}` });
      return;
    }

    if (activeSection === 'checks') {
      const selectedCheck = currentChecks[activeItemIndex];
      if (!selectedCheck) return;
      if (selectedCheck.detailsUrl) {
        window.open(selectedCheck.detailsUrl, '_blank', 'noopener,noreferrer');
        return;
      }
      if (!onInjectChatContext) {
        setActionResult({ type: 'error', message: 'No quick action is available for this check here.' });
        return;
      }
      const checkName = selectedCheck.name || 'Unknown check';
      const injectionKey = checkContextKey(selectedCheck.name);
      if (addedContextKeys[injectionKey]) {
        setActionResult({ type: 'success', message: `${checkName} is already in chat.` });
        return;
      }
      injectPayload(
        injectionKey,
        formatCiCheckInjection({
          prNumber: pr.number,
          repo,
          name: checkName,
          status: selectedCheck.status,
          conclusion: selectedCheck.conclusion,
          detailsUrl: selectedCheck.detailsUrl,
          startedAt: selectedCheck.startedAt,
          completedAt: selectedCheck.completedAt,
        }),
      );
      setActionResult({ type: 'success', message: `Added ${checkName} to chat.` });
      return;
    }

    if (activeSection === 'comments') {
      const selectedComment = currentVisibleComments[activeItemIndex];
      if (!selectedComment) return;
      if (!onInjectChatContext) {
        setActionResult({ type: 'error', message: 'Chat injection is unavailable from this surface.' });
        return;
      }
      const commentKey = `${selectedComment.kind}:${selectedComment.id}`;
      if (addedContextKeys[commentKey]) {
        setActionResult({ type: 'success', message: 'That comment is already in chat.' });
        return;
      }
      injectPayload(
        commentKey,
        formatReviewCommentInjection({
          prNumber: pr.number,
          repo,
          author: selectedComment.user,
          body: selectedComment.body,
          createdAt: selectedComment.created_at,
          path: selectedComment.kind === 'review' ? (selectedComment as { path?: string }).path : undefined,
        }),
      );
      setActionResult({ type: 'success', message: `Added ${selectedComment.user}'s comment to chat.` });
      return;
    }

    if (activeSection === 'reviews') {
      const selectedReviewThread = currentVisibleReviewThreads[activeItemIndex];
      if (!selectedReviewThread) return;
      if (!onInjectChatContext) {
        setActionResult({ type: 'error', message: 'Chat injection is unavailable from this surface.' });
        return;
      }
      const reviewKey = `review-thread:${selectedReviewThread.id}`;
      if (addedContextKeys[reviewKey]) {
        setActionResult({ type: 'success', message: 'That review thread is already in chat.' });
        return;
      }
      injectPayload(
        reviewKey,
        formatReviewThreadInjection({
          prNumber: pr.number,
          repo,
          status: selectedReviewThread.status,
          path: selectedReviewThread.path,
          line: selectedReviewThread.line,
          comments: selectedReviewThread.comments.map((comment) => ({
            prNumber: pr.number,
            repo,
            author: comment.author,
            body: comment.body,
            createdAt: comment.createdAt,
            path: comment.path,
            line: comment.line,
          })),
        }),
      );
      setViewedThreadIds((current) => ({ ...current, [selectedReviewThread.id]: true }));
      setActionResult({ type: 'success', message: `Added ${selectedReviewThread.path} to chat.` });
    }
  }, [
    activeItemIndex,
    activeSection,
    addedContextKeys,
    currentChecks,
    currentVisibleComments,
    currentVisibleReviewThreads,
    checkContextKey,
    injectPayload,
    onInjectChatContext,
    pr,
    prNumber,
    repo,
  ]);

  useEffect(() => {
    if (!pr) return undefined;

    const orderedSections: Array<'overview' | 'files' | 'checks' | 'comments' | 'reviews'> = ['overview', 'files', 'checks', 'comments', 'reviews'];
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingTarget = Boolean(
        target && (
          target.tagName === 'INPUT'
          || target.tagName === 'TEXTAREA'
          || target.isContentEditable
        ),
      );

      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && pr.state === 'OPEN' && commentText.trim()) {
        event.preventDefault();
        void submitAction('comment', commentText);
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (isTypingTarget) {
        if (event.key === 'Escape' && target === commentInputRef.current) {
          commentInputRef.current?.blur();
        }
        return;
      }

      if (/^[1-5]$/.test(event.key)) {
        const section = orderedSections[Number(event.key) - 1];
        if (section) {
          event.preventDefault();
          setActiveSection(section);
        }
        return;
      }

      if (event.key === '[' || event.key === ']') {
        event.preventDefault();
        const currentIndex = orderedSections.indexOf(activeSection);
        const delta = event.key === '[' ? -1 : 1;
        const nextIndex = Math.min(orderedSections.length - 1, Math.max(0, currentIndex + delta));
        setActiveSection(orderedSections[nextIndex]);
        return;
      }

      if (event.key.toLowerCase() === 'o' && repo) {
        event.preventDefault();
        openPullRequestOnGitHub();
        return;
      }

      if ((event.key.toLowerCase() === 'j' || event.key === 'ArrowDown') && activeSection !== 'overview' && activeSectionItemCount > 0) {
        event.preventDefault();
        setActiveItemIndex((current) => Math.min(activeSectionItemCount - 1, current + 1));
        return;
      }

      if ((event.key.toLowerCase() === 'k' || event.key === 'ArrowUp') && activeSection !== 'overview' && activeSectionItemCount > 0) {
        event.preventDefault();
        setActiveItemIndex((current) => Math.max(0, current - 1));
        return;
      }

      if (event.key === 'Enter' && activeSection !== 'overview' && activeSectionItemCount > 0) {
        event.preventDefault();
        void runSelectedItemAction();
        return;
      }

      if (pr.state !== 'OPEN') return;

      if (event.key.toLowerCase() === 'c') {
        event.preventDefault();
        focusCommentComposer();
        return;
      }

      if (actionLoading !== null) return;

      if (event.key.toLowerCase() === 'a') {
        event.preventDefault();
        void submitAction('approve', commentText || undefined);
        return;
      }

      if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        if (!commentText.trim()) {
          focusCommentComposer();
          return;
        }
        void submitAction('request-changes', commentText);
        return;
      }

      if (event.key.toLowerCase() === 'm') {
        event.preventDefault();
        void submitAction('merge');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    activeSection,
    activeSectionItemCount,
    actionLoading,
    commentText,
    focusCommentComposer,
    openPullRequestOnGitHub,
    pr,
    repo,
    runSelectedItemAction,
    submitAction,
  ]);

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading PR…</div>;
  }

  if (error || !pr) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        height: '100%',
        padding: 24,
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 13, color: '#ef4444', lineHeight: 1.5 }}>
          Failed to load PR: {error || 'Unknown'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            type="button"
            onClick={() => setReloadNonce((current) => current + 1)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid rgba(37, 99, 235, 0.18)',
              background: 'rgba(37, 99, 235, 0.08)',
              color: '#2563eb',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            <RefreshCw size={12} strokeWidth={2.2} />
            Retry
          </button>
          {repo ? (
            <button
              type="button"
              onClick={() => window.open(`https://github.com/${repo}/pull/${prNumber}`, '_blank', 'noopener,noreferrer')}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 12px',
                borderRadius: 10,
                border: '1px solid rgba(15, 23, 42, 0.1)',
                background: 'var(--t-panel)',
                color: 'var(--t-text)',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
            >
              <ExternalLink size={12} strokeWidth={2.2} />
              Open on GitHub
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const stateStyle = prStateStyles[pr.state] ?? { color: '#6b7280', label: pr.state, bg: 'rgba(0,0,0,0.04)' };
  const allComments = currentAllComments;
  const ciChecks = currentChecks;
  const passedChecks = ciChecks.filter(c => c.conclusion === 'SUCCESS' || c.conclusion === 'success').length;

  const sections: { id: 'overview' | 'files' | 'checks' | 'comments' | 'reviews'; label: string; count?: number; shortcut: string }[] = [
    { id: 'overview', label: 'Overview', shortcut: '1' },
    { id: 'files', label: 'Files', count: pr.changedFiles, shortcut: '2' },
    { id: 'checks', label: 'Checks', count: ciChecks.length, shortcut: '3' },
    { id: 'comments', label: 'Comments', count: allComments.length, shortcut: '4' },
    { id: 'reviews', label: 'Threads', count: reviewThreads.length, shortcut: '5' },
  ];
  const visibleComments = currentVisibleComments;
  const visibleReviewThreads = currentVisibleReviewThreads;
  const reviewThreadCounts = {
    active: visibleReviewThreads.filter((thread) => thread.status === 'active').length,
    outdated: visibleReviewThreads.filter((thread) => thread.status === 'outdated').length,
    resolved: visibleReviewThreads.filter((thread) => thread.status === 'resolved').length,
  };
  const failedChecks = ciChecks.filter((check) => check.conclusion && check.conclusion.toLowerCase() !== 'success');
  const pendingChecks = ciChecks.filter((check) => !check.conclusion || check.status?.toLowerCase() !== 'completed');
  const reviews = pr.reviews ?? [];
  const requestedChangesCount = reviews.filter((review) => review.state?.toLowerCase() === 'changes_requested').length;
  const approvedCount = reviews.filter((review) => review.state?.toLowerCase() === 'approved').length;
  const reviewStage = deriveWorkflowStage({
    prState: pr.state,
    requestedChanges: requestedChangesCount,
    failedChecks: failedChecks.length,
    pendingChecks: pendingChecks.length,
  });
  const reviewGuidance = describeWorkflowStage({
    stage: reviewStage,
    prState: pr.state,
    requestedChanges: requestedChangesCount,
    approvedCount,
    failedChecks: failedChecks.length,
    pendingChecks: pendingChecks.length,
  });
  const reviewStatus = reviewStage
    ? {
        label: reviewStage.label,
        detail: reviewGuidance.detail,
        nextAction: reviewGuidance.nextAction,
        tone: reviewStage.key === 'blocked'
          ? { background: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.18)', color: '#b91c1c' }
          : reviewStage.key === 'waiting'
            ? { background: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.18)', color: '#b45309' }
            : reviewStage.key === 'merge_ready'
              ? { background: 'rgba(34,197,94,0.10)', border: 'rgba(34,197,94,0.18)', color: '#15803d' }
              : readinessTone(pr.readiness),
      }
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#ffffff', ...LIGHT_CANVAS_VARS }}>
      {/* Header */}
      <div style={{
        paddingTop: 16,
        paddingRight: 20,
        paddingBottom: 12,
        paddingLeft: 20,
        borderBottom: '1px solid #e5e7eb',
        background: '#ffffff',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            paddingTop: 3,
            paddingRight: 8,
            paddingBottom: 3,
            paddingLeft: 8,
            borderRadius: 99,
            fontSize: 11,
            fontWeight: 600,
            color: stateStyle.color,
            background: stateStyle.bg,
          }}>
            {stateStyle.label}
          </span>
          <span style={{ fontSize: 15, fontWeight: 600, color: '#111827' }}>
            #{pr.number} {pr.title}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6, fontSize: 12, color: '#6b7280' }}>
          <span>{pr.author.login}</span>
          <span>wants to merge</span>
          <span style={{
            fontFamily: '"SF Mono", ui-monospace, monospace',
            fontSize: 11,
            paddingTop: 1,
            paddingRight: 5,
            paddingBottom: 1,
            paddingLeft: 5,
            borderRadius: 4,
            background: '#f3f4f6',
            color: '#374151',
          }}>{pr.headRefName}</span>
          <span>→</span>
          <span style={{
            fontFamily: '"SF Mono", ui-monospace, monospace',
            fontSize: 11,
            paddingTop: 1,
            paddingRight: 5,
            paddingBottom: 1,
            paddingLeft: 5,
            borderRadius: 4,
            background: '#f3f4f6',
            color: '#374151',
          }}>{pr.baseRefName}</span>
          <span>·</span>
          <span style={{ color: '#22c55e', fontWeight: 600 }}>+{pr.additions}</span>
          <span style={{ color: '#ef4444', fontWeight: 600 }}>-{pr.deletions}</span>
          <span>·</span>
          <span>{formatAge(pr.createdAt)}</span>
          {reviewStatus ? (
            <>
              <span>·</span>
              <span
                title={reviewStatus.detail}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '2px 8px',
                  borderRadius: 999,
                  border: `1px solid ${reviewStatus.tone.border}`,
                  background: reviewStatus.tone.background,
                  color: reviewStatus.tone.color,
                  fontSize: 10,
                  fontWeight: 700,
                }}
              >
                {reviewStatus.label}
              </span>
            </>
          ) : null}
        </div>
        {pr.mergedBy ? (
          <div style={{ fontSize: 12, color: '#8b5cf6', marginTop: 4 }}>
            Merged by {pr.mergedBy.login} {pr.mergedAt ? formatAge(pr.mergedAt) : ''}
          </div>
        ) : null}

        {/* Section tabs + actions row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 10 }}>
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveSection(s.id)}
              style={{
                paddingTop: 5,
                paddingRight: 12,
                paddingBottom: 5,
                paddingLeft: 12,
                borderRadius: 8,
                border: 'none',
                fontSize: 12,
                fontWeight: activeSection === s.id ? 600 : 400,
                color: activeSection === s.id ? '#2563eb' : '#6b7280',
                background: activeSection === s.id ? 'rgba(37,99,235,0.08)' : 'transparent',
                cursor: 'pointer',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
              title={`Shortcut ${s.shortcut}`}
            >
              {s.label}{s.count !== undefined ? ` (${s.count})` : ''}
              <span style={{
                marginLeft: 6,
                fontSize: 10,
                fontWeight: 700,
                color: activeSection === s.id ? '#1d4ed8' : '#9ca3af',
              }}>
                {s.shortcut}
              </span>
            </button>
          ))}

          {/* Action buttons — only for open PRs */}
          {pr.state === 'OPEN' && (
            <>
              <div style={{ flex: 1 }} />
              <button
                type="button"
                onClick={() => submitAction('approve', commentText || undefined)}
                disabled={actionLoading !== null}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  paddingTop: 5,
                  paddingRight: 10,
                  paddingBottom: 5,
                  paddingLeft: 8,
                  borderRadius: 8,
                  border: '1px solid rgba(34, 197, 94, 0.2)',
                  background: actionLoading === 'approve' ? 'rgba(34,197,94,0.15)' : 'rgba(34,197,94,0.06)',
                  color: '#22c55e',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: actionLoading ? 'wait' : 'pointer',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                }}
              >
                <Check size={12} strokeWidth={2.5} />
                Approve
                <span style={{ fontSize: 10, opacity: 0.75 }}>A</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!commentText) { setActiveSection('comments'); return; }
                  submitAction('request-changes', commentText);
                }}
                disabled={actionLoading !== null}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  paddingTop: 5,
                  paddingRight: 10,
                  paddingBottom: 5,
                  paddingLeft: 8,
                  borderRadius: 8,
                  border: '1px solid rgba(239, 68, 68, 0.2)',
                  background: actionLoading === 'request-changes' ? 'rgba(239,68,68,0.15)' : 'rgba(239,68,68,0.06)',
                  color: '#ef4444',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: actionLoading ? 'wait' : 'pointer',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                }}
              >
                <XCircle size={12} strokeWidth={2.5} />
                Changes
                <span style={{ fontSize: 10, opacity: 0.75 }}>R</span>
              </button>
              <button
                type="button"
                onClick={() => submitAction('merge')}
                disabled={actionLoading !== null || !reviewGuidance.mergeAllowed}
                title={!reviewGuidance.mergeAllowed ? reviewGuidance.mergeDetail : 'Merge this pull request'}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  paddingTop: 5,
                  paddingRight: 10,
                  paddingBottom: 5,
                  paddingLeft: 8,
                  borderRadius: 8,
                  border: '1px solid rgba(139, 92, 246, 0.2)',
                  background: actionLoading === 'merge'
                    ? 'rgba(139,92,246,0.15)'
                    : !reviewGuidance.mergeAllowed
                      ? 'rgba(148,163,184,0.12)'
                      : 'rgba(139,92,246,0.06)',
                  color: !reviewGuidance.mergeAllowed ? 'var(--t-text-muted)' : '#8b5cf6',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: actionLoading ? 'wait' : reviewGuidance.mergeAllowed ? 'pointer' : 'not-allowed',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  opacity: reviewGuidance.mergeAllowed ? 1 : 0.7,
                }}
              >
                <GitMerge size={12} strokeWidth={2.5} />
                Merge
                <span style={{ fontSize: 10, opacity: 0.75 }}>M</span>
              </button>
            </>
          )}
        </div>

        {/* Action result toast */}
        {actionResult && (
          <div style={{
            marginTop: 6,
            paddingTop: 4,
            paddingRight: 10,
            paddingBottom: 4,
            paddingLeft: 10,
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 500,
            color: actionResult.type === 'success' ? '#22c55e' : '#ef4444',
            background: actionResult.type === 'success' ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)',
          }}>
            {actionResult.message}
          </div>
        )}
      </div>

      {/* Comment compose bar — for open PRs */}
      {pr.state === 'OPEN' && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 6,
          paddingRight: 20,
          paddingBottom: 6,
          paddingLeft: 20,
          borderBottom: '1px solid #e5e7eb',
          background: '#f9fafb',
          flexShrink: 0,
        }}>
          <input
            ref={commentInputRef}
            name="reviewComment"
            type="text"
            placeholder="Add a comment… (C focuses, Cmd/Ctrl+Enter sends)"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={(e) => {
              if (((e.metaKey || e.ctrlKey) || !e.shiftKey) && e.key === 'Enter' && commentText.trim()) {
                e.preventDefault();
                submitAction('comment', commentText);
              }
            }}
            style={{
              flex: 1,
              border: '1px solid var(--t-divider)',
              borderRadius: 8,
              paddingTop: 6,
              paddingRight: 10,
              paddingBottom: 6,
              paddingLeft: 10,
              fontSize: 12,
              background: 'var(--t-panel)',
              color: 'var(--t-text)',
              outline: 'none',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          />
          <button
            type="button"
            onClick={() => { if (commentText.trim()) submitAction('comment', commentText); }}
            disabled={!commentText.trim() || actionLoading !== null}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              paddingTop: 6,
              paddingRight: 10,
              paddingBottom: 6,
              paddingLeft: 10,
              borderRadius: 8,
              border: 'none',
              background: commentText.trim() ? '#2563eb' : 'var(--t-divider)',
              color: commentText.trim() ? '#fff' : 'var(--t-text-muted)',
              fontSize: 11,
              fontWeight: 600,
              cursor: commentText.trim() ? 'pointer' : 'default',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
            >
              <Send size={11} />
              Comment
              <span style={{ fontSize: 10, opacity: 0.8 }}>⌘↵</span>
            </button>
          </div>
        )}

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 16, paddingRight: 20, paddingBottom: 16, paddingLeft: 20, color: '#374151' }}>
        {activeSection === 'overview' ? (
          <div>
            {/* CI Status */}
            {ciChecks.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  CI Checks ({passedChecks}/{ciChecks.length} passed)
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {ciChecks.map((check, i) => {
                    const passed = check.conclusion === 'SUCCESS' || check.conclusion === 'success';
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                        <span style={{ color: passed ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                          {passed ? '✓' : '✗'}
                        </span>
                        <span style={{ color: 'var(--t-text-strong)' }}>{check.name}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* Reviews */}
            {reviews.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Reviews
                </div>
                {reviews.map((review, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 4 }}>
                    <span style={{
                      color: review.state === 'APPROVED' ? '#22c55e' : review.state === 'CHANGES_REQUESTED' ? '#ef4444' : '#f59e0b',
                      fontWeight: 600,
                    }}>
                      {review.state === 'APPROVED' ? '✓' : review.state === 'CHANGES_REQUESTED' ? '✗' : '○'}
                    </span>
                    <span style={{ color: 'var(--t-text-strong)' }}>{review.author.login}</span>
                    <span style={{ color: 'var(--t-text-muted)' }}>{review.state.toLowerCase().replace('_', ' ')}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {/* Labels */}
            {pr.labels.length > 0 ? (
              <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
                {pr.labels.map((label) => (
                  <span key={label.name} style={{
                    fontSize: 11,
                    fontWeight: 600,
                    paddingTop: 2,
                    paddingRight: 8,
                    paddingBottom: 2,
                    paddingLeft: 8,
                    borderRadius: 99,
                    color: `#${label.color}`,
                    background: `#${label.color}10`,
                    border: `1px solid #${label.color}25`,
                  }}>
                    {label.name}
                  </span>
                ))}
              </div>
            ) : null}

            {/* Body */}
            {pr.body ? (
              <div style={{ marginTop: 8 }}>
                <MarkdownBody text={pr.body} />
              </div>
            ) : (
              <div style={{ fontSize: 13, color: '#9ca3af', fontStyle: 'italic' }}>No description provided</div>
            )}
          </div>
        ) : null}

        {activeSection === 'files' ? (
          <div>
            {pr.files?.length > 0 ? (
              pr.files.map((file, index) => (
                <div key={file.path} data-pr-section="files" data-pr-index={index} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  paddingTop: 6,
                  paddingRight: 10,
                  paddingBottom: 6,
                  paddingLeft: 8,
                  borderRadius: 10,
                  borderBottom: '1px solid var(--t-divider-subtle)',
                  fontSize: 13,
                  background: activeItemIndex === index ? 'rgba(37,99,235,0.08)' : 'transparent',
                  border: activeItemIndex === index ? '1px solid rgba(37,99,235,0.16)' : '1px solid transparent',
                }}>
                  <FileText size={14} strokeWidth={1.8} style={{ color: 'var(--t-text-muted)', flexShrink: 0 }} />
                  <span style={{ flex: 1, color: 'var(--t-text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {file.path}
                  </span>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0, fontSize: 11, fontWeight: 600 }}>
                    {file.additions > 0 ? <span style={{ color: '#22c55e' }}>+{file.additions}</span> : null}
                    {file.deletions > 0 ? <span style={{ color: '#ef4444' }}>-{file.deletions}</span> : null}
                  </div>
                  <span style={{ fontSize: 10, color: 'var(--t-text-faint)', flexShrink: 0 }}>
                    ↵ copies path
                  </span>
                </div>
              ))
            ) : (
              <div style={{ fontSize: 13, color: 'var(--t-text-muted)' }}>No changed files data</div>
            )}
            {pr.diffStat ? (
              <pre style={{
                marginTop: 12,
                fontSize: '0.75rem',
                lineHeight: 1.5,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                color: 'var(--t-text-secondary)',
                whiteSpace: 'pre-wrap',
              }}>
                {pr.diffStat}
              </pre>
            ) : null}
          </div>
        ) : null}

        {activeSection === 'checks' ? (
          <div>
            {ciChecks.length === 0 ? (
              <div style={{ padding: 20, fontSize: 13, color: 'var(--t-text-muted)' }}>No checks configured</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {failedChecks.length > 0 && onInjectChatContext ? (
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <DesktopGlassActionChip
                      icon={<MessageSquare size={12} strokeWidth={2} />}
                      label={addedContextKeys[`checks-all:${pr.number}`] ? 'Added to chat' : 'Add all failed checks'}
                      onClick={() => injectPayload(
                        `checks-all:${pr.number}`,
                        formatCiCheckBatchInjection(
                          pr.number,
                          repo,
                          failedChecks.map((check) => ({
                            prNumber: pr.number,
                            repo,
                            name: check.name,
                            status: check.status,
                            conclusion: check.conclusion,
                            detailsUrl: check.detailsUrl,
                            startedAt: check.startedAt,
                            completedAt: check.completedAt,
                          })),
                        ),
                      )}
                      disabled={Boolean(addedContextKeys[`checks-all:${pr.number}`])}
                    />
                  </div>
                ) : null}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {ciChecks.map((check, i) => {
                  const passed = check.conclusion === 'SUCCESS' || check.conclusion === 'success';
                  const pending = check.status === 'IN_PROGRESS' || check.status === 'QUEUED' || check.status === 'PENDING';
                  const failed = !passed && !pending;
                  const rowBackground = activeItemIndex === i ? 'rgba(37,99,235,0.08)' : 'transparent';
                  // Calculate duration
                  let duration = '';
                  if (check.startedAt && check.completedAt) {
                    const ms = new Date(check.completedAt).getTime() - new Date(check.startedAt).getTime();
                    if (ms < 60_000) duration = `${Math.round(ms / 1000)}s`;
                    else duration = `${Math.round(ms / 60_000)}m`;
                  }
                  return (
                    <div key={i} data-pr-section="checks" data-pr-index={i} style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 12px',
                      borderRadius: 8,
                      transition: 'background 120ms ease',
                      cursor: check.detailsUrl ? 'pointer' : 'default',
                      background: rowBackground,
                      border: activeItemIndex === i ? '1px solid rgba(37,99,235,0.16)' : '1px solid transparent',
                    }}
                    onClick={() => check.detailsUrl && window.open(check.detailsUrl, '_blank')}
                    onMouseEnter={(e) => {
                      if (activeItemIndex !== i) {
                        (e.currentTarget as HTMLDivElement).style.background = 'rgba(0,0,0,0.02)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLDivElement).style.background = rowBackground;
                    }}
                    >
                      {/* Status icon */}
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 20, height: 20,
                        borderRadius: '50%',
                        background: passed ? 'rgba(34,197,94,0.08)' : pending ? 'rgba(245,158,11,0.08)' : 'rgba(239,68,68,0.08)',
                        color: passed ? '#22c55e' : pending ? '#f59e0b' : '#ef4444',
                        fontSize: 12, fontWeight: 700,
                        flexShrink: 0,
                        }}>
                          {passed ? '✓' : pending ? '○' : '✗'}
                        </span>
                      {/* Check name */}
                      <span style={{
                        flex: 1,
                        fontSize: 13,
                        fontWeight: 500,
                        color: 'var(--t-text-strong)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {check.name}
                      </span>
                      {/* Duration */}
                      {duration ? (
                        <span style={{
                          fontSize: 11,
                          color: 'var(--t-text-muted)',
                          fontFamily: '"SF Mono", ui-monospace, monospace',
                          flexShrink: 0,
                        }}>
                          {duration}
                        </span>
                      ) : null}
                      {/* External link */}
                      {check.detailsUrl ? (
                        <ExternalLink size={12} strokeWidth={1.5} color="var(--t-text-faint)" style={{ flexShrink: 0 }} />
                      ) : null}
                      {!passed && onInjectChatContext ? (
                        <DesktopGlassActionChip
                          icon={addedContextKeys[checkContextKey(check.name)] ? <Check size={12} strokeWidth={2.4} /> : <MessageSquare size={12} strokeWidth={2} />}
                          label={addedContextKeys[checkContextKey(check.name)] ? 'Added' : 'Add to chat'}
                          onClick={() => injectPayload(
                            checkContextKey(check.name),
                            formatCiCheckInjection({
                              prNumber: pr.number,
                              repo,
                              name: check.name,
                              status: check.status,
                              conclusion: check.conclusion,
                              detailsUrl: check.detailsUrl,
                              startedAt: check.startedAt,
                              completedAt: check.completedAt,
                            }),
                          )}
                          disabled={Boolean(addedContextKeys[checkContextKey(check.name)])}
                        />
                      ) : null}
                    </div>
                  );
                })}
                </div>
              </div>
            )}
          </div>
        ) : null}

        {activeSection === 'comments' ? (
          <div>
            {visibleComments.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--t-text-muted)' }}>No comments</div>
            ) : (
              <>
                {onInjectChatContext ? (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                    <DesktopGlassActionChip
                      icon={<MessageSquare size={12} strokeWidth={2} />}
                      label={addedContextKeys[`comments-all:${pr.number}`] ? 'Added to chat' : 'Add all to chat'}
                      onClick={() => injectPayload(
                        `comments-all:${pr.number}`,
                        formatReviewCommentBatchInjection(
                          pr.number,
                          repo,
                          visibleComments.map((comment) => ({
                            prNumber: pr.number,
                            repo,
                            author: comment.user,
                            body: comment.body,
                            createdAt: comment.created_at,
                            path: comment.kind === 'review' ? (comment as { path?: string }).path : undefined,
                          })),
                        ),
                      )}
                      disabled={Boolean(addedContextKeys[`comments-all:${pr.number}`])}
                    />
                  </div>
                ) : null}
              {visibleComments.map((comment, index) => {
                const commentKey = `${comment.kind}:${comment.id}`;
                const isBot = comment.user.endsWith('[bot]') || comment.user === 'github-actions';
                const isHovered = hoveredCommentKey === commentKey;
                const isAdded = Boolean(addedContextKeys[commentKey]);
                return (
                <div
                  key={`${comment.kind}-${comment.id}`}
                  data-pr-section="comments"
                  data-pr-index={index}
                  onMouseEnter={() => setHoveredCommentKey(commentKey)}
                  onMouseLeave={() => setHoveredCommentKey(null)}
                  style={{
                    marginBottom: 4,
                    paddingBottom: 8,
                    paddingLeft: 10,
                    paddingRight: 10,
                    paddingTop: 8,
                    borderRadius: 8,
                    borderBottom: '1px solid #f3f4f6',
                    background: activeItemIndex === index ? 'rgba(37,99,235,0.04)' : 'transparent',
                    border: activeItemIndex === index ? '1px solid rgba(37,99,235,0.14)' : '1px solid transparent',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 11 }}>
                    <span style={{ fontWeight: 600, color: isBot ? '#6b7280' : '#111827', fontSize: isBot ? 11 : 12 }}>{comment.user}</span>
                    {comment.kind === 'review' ? (
                      <span style={{
                        fontSize: 10,
                        paddingTop: 1,
                        paddingRight: 5,
                        paddingBottom: 1,
                        paddingLeft: 5,
                        borderRadius: 4,
                        background: 'rgba(139,92,246,0.08)',
                        color: '#8b5cf6',
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                      }}>
                        {'path' in comment ? (comment as { path: string }).path : 'review'}
                      </span>
                    ) : null}
                    <span style={{ color: '#9ca3af', fontSize: 11 }}>{formatAge(comment.created_at)}</span>
                    {onInjectChatContext && (isHovered || isAdded) ? (
                      <>
                        <div style={{ flex: 1 }} />
                        <DesktopGlassActionChip
                          icon={isAdded ? <Check size={11} strokeWidth={2.4} /> : <MessageSquare size={11} strokeWidth={2} />}
                          label={isAdded ? 'Added' : 'Add'}
                          onClick={() => injectPayload(
                            commentKey,
                            formatReviewCommentInjection({
                              prNumber: pr.number,
                              repo,
                              author: comment.user,
                              body: comment.body,
                              createdAt: comment.created_at,
                              path: comment.kind === 'review' ? (comment as { path?: string }).path : undefined,
                            }),
                          )}
                          disabled={isAdded}
                        />
                        {isHovered ? (
                          <DesktopGlassActionChip
                            icon={<X size={11} strokeWidth={2.2} />}
                            label="Hide"
                            variant="muted"
                            onClick={() => hideComment(commentKey)}
                          />
                        ) : null}
                      </>
                    ) : null}
                  </div>
                  <div style={{ fontSize: isBot ? 12 : 13, lineHeight: 1.5 }}>
                    <MarkdownBody text={comment.body} compact={isBot} />
                  </div>
                </div>
                );
              })}
              </>
            )}
          </div>
        ) : null}

        {activeSection === 'reviews' ? (
          <div>
            {visibleReviewThreads.length > 0 ? (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                flexWrap: 'wrap',
                marginBottom: 12,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {(['active', 'outdated', 'resolved'] as ReviewThreadStatus[]).map((status) => {
                    const tone = reviewThreadTone(status);
                    const count = reviewThreadCounts[status];
                    return (
                      <span
                        key={status}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          paddingTop: 4,
                          paddingRight: 10,
                          paddingBottom: 4,
                          paddingLeft: 10,
                          borderRadius: 999,
                          border: `1px solid ${tone.pillBorder}`,
                          background: tone.pillBackground,
                          color: tone.color,
                          fontSize: 11,
                          fontWeight: 700,
                        }}
                      >
                        {tone.label}
                        <span style={{ color: 'var(--t-text-secondary)' }}>{count}</span>
                      </span>
                    );
                  })}
                </div>
                {onInjectChatContext ? (
                  <DesktopGlassActionChip
                    icon={<MessageSquare size={12} strokeWidth={2} />}
                    label={addedContextKeys[`review-threads-all:${pr.number}`] ? 'Added to chat' : 'Add all to chat'}
                    onClick={() => injectPayload(
                      `review-threads-all:${pr.number}`,
                      formatReviewCommentBatchInjection(
                        pr.number,
                        repo,
                        visibleReviewThreads.flatMap((thread) => thread.comments.map((comment) => ({
                          prNumber: pr.number,
                          repo,
                          author: comment.author,
                          body: comment.body,
                          createdAt: comment.createdAt,
                          path: comment.path,
                          line: comment.line,
                        }))),
                      ),
                    )}
                    disabled={Boolean(addedContextKeys[`review-threads-all:${pr.number}`])}
                  />
                ) : null}
              </div>
            ) : null}

            {reviewThreadsError ? (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                paddingTop: 12,
                paddingRight: 14,
                paddingBottom: 12,
                paddingLeft: 14,
                borderRadius: 16,
                border: '1px solid rgba(239,68,68,0.16)',
                background: 'linear-gradient(180deg, rgba(255,255,255,0.88), rgba(254,242,242,0.82))',
                boxShadow: '0 14px 28px rgba(239, 68, 68, 0.08)',
                marginBottom: 12,
                flexWrap: 'wrap',
              }}>
                <AlertCircle size={16} strokeWidth={2.1} style={{ color: '#b91c1c', flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 180, fontSize: 13, color: '#991b1b' }}>
                  {reviewThreadsError}
                </span>
                <button
                  type="button"
                  onClick={() => { void fetchReviewThreads(); }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    minHeight: 44,
                    paddingTop: 8,
                    paddingRight: 14,
                    paddingBottom: 8,
                    paddingLeft: 14,
                    borderRadius: 999,
                    border: '1px solid rgba(239,68,68,0.18)',
                    background: 'rgba(255,255,255,0.82)',
                    color: '#b91c1c',
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                  }}
                >
                  <RotateCcw size={14} strokeWidth={2} />
                  Retry
                </button>
              </div>
            ) : null}

            {reviewsLoading && visibleReviewThreads.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--t-text-muted)' }}>Loading review threads…</div>
            ) : null}

            {!reviewsLoading && visibleReviewThreads.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--t-text-muted)' }}>No review threads</div>
            ) : null}

            {visibleReviewThreads.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {visibleReviewThreads.map((thread, index) => {
                  const threadKey = `review-thread:${thread.id}`;
                  const tone = reviewThreadTone(thread.status);
                  const isViewed = Boolean(viewedThreadIds[thread.id]);
                  const isCollapsed = Boolean(collapsedThreadIds[thread.id]);
                  const location = formatReviewThreadLocation(thread);
                  const latestComment = thread.comments[thread.comments.length - 1] ?? null;
                  const threadLoadingState = threadActionLoading[thread.id] ?? null;

                  return (
                    <div
                      key={thread.id}
                      data-pr-section="reviews"
                      data-pr-index={index}
                      style={{
                        borderRadius: 18,
                        border: activeItemIndex === index
                          ? `1px solid ${tone.accent}`
                          : `1px solid ${tone.border}`,
                        background: tone.background,
                        boxShadow: activeItemIndex === index
                          ? '0 18px 32px rgba(37, 99, 235, 0.12)'
                          : '0 10px 24px rgba(15, 23, 42, 0.05)',
                        overflow: 'hidden',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          toggleCollapsedThread(thread.id);
                          setViewedThreadIds((current) => ({ ...current, [thread.id]: true }));
                        }}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          minHeight: 44,
                          paddingTop: 14,
                          paddingRight: 16,
                          paddingBottom: 14,
                          paddingLeft: 16,
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          textAlign: 'left',
                          fontFamily: '-apple-system, system-ui, sans-serif',
                        }}
                      >
                        <span style={{
                          width: 30,
                          height: 30,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: 999,
                          background: tone.pillBackground,
                          color: tone.color,
                          flexShrink: 0,
                        }}>
                          {isCollapsed ? <ChevronRight size={16} strokeWidth={2.1} /> : <ChevronDown size={16} strokeWidth={2.1} />}
                        </span>
                        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{
                              fontSize: 12,
                              fontWeight: 700,
                              color: 'var(--t-text-strong)',
                              fontFamily: '"SF Mono", ui-monospace, monospace',
                              textDecorationLine: tone.summaryDecoration,
                            }}>
                              {thread.path}
                            </span>
                            {location ? (
                              <span style={{
                                fontSize: 11,
                                color: 'var(--t-text-secondary)',
                                fontFamily: '"SF Mono", ui-monospace, monospace',
                              }}>
                                L{location}
                              </span>
                            ) : null}
                            <span style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              paddingTop: 3,
                              paddingRight: 8,
                              paddingBottom: 3,
                              paddingLeft: 8,
                              borderRadius: 999,
                              border: `1px solid ${tone.pillBorder}`,
                              background: tone.pillBackground,
                              color: tone.color,
                              fontSize: 10,
                              fontWeight: 800,
                            }}>
                              {tone.label}
                            </span>
                            <span style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              paddingTop: 3,
                              paddingRight: 8,
                              paddingBottom: 3,
                              paddingLeft: 8,
                              borderRadius: 999,
                              border: `1px solid ${isViewed ? 'rgba(22,163,74,0.18)' : 'rgba(245,158,11,0.18)'}`,
                              background: isViewed ? 'rgba(22,163,74,0.10)' : 'rgba(245,158,11,0.10)',
                              color: isViewed ? '#15803d' : '#b45309',
                              fontSize: 10,
                              fontWeight: 800,
                            }}>
                              {isViewed ? 'Viewed' : 'Unviewed'}
                            </span>
                            {thread.resolvedBy ? (
                              <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>
                                resolved by {thread.resolvedBy}
                              </span>
                            ) : null}
                          </div>
                          <div style={{
                            fontSize: 13,
                            lineHeight: 1.5,
                            color: 'var(--t-text-secondary)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            textDecorationLine: tone.summaryDecoration,
                          }}>
                            {latestComment?.body.trim() || 'Review thread'}
                          </div>
                        </div>
                        <span style={{ fontSize: 11, color: 'var(--t-text-muted)', flexShrink: 0 }}>
                          {latestComment?.createdAt ? formatAge(latestComment.createdAt) : ''}
                        </span>
                      </button>

                      {!isCollapsed ? (
                        <div style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 12,
                          paddingTop: 0,
                          paddingRight: 16,
                          paddingBottom: 16,
                          paddingLeft: 16,
                        }}>
                          {thread.comments[0]?.diffHunk ? (
                            <pre style={{
                              marginTop: 0,
                              marginRight: 0,
                              marginBottom: 0,
                              marginLeft: 0,
                              paddingTop: 10,
                              paddingRight: 12,
                              paddingBottom: 10,
                              paddingLeft: 12,
                              fontSize: '0.72rem',
                              lineHeight: 1.5,
                              fontFamily: '"SF Mono", ui-monospace, monospace',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              color: 'var(--t-text-secondary)',
                              background: 'rgba(255,255,255,0.72)',
                              borderRadius: 14,
                              border: `1px solid ${tone.border}`,
                              maxHeight: 140,
                              overflowY: 'auto',
                            }}>
                              {renderDiffLines(thread.comments[0].diffHunk)}
                            </pre>
                          ) : null}

                          {thread.comments.map((comment) => (
                            <div
                              key={comment.id}
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 8,
                                paddingTop: 12,
                                paddingRight: 14,
                                paddingBottom: 12,
                                paddingLeft: 14,
                                borderRadius: 16,
                                border: `1px solid ${comment.isOptimistic ? 'rgba(245,158,11,0.22)' : 'rgba(148,163,184,0.18)'}`,
                                background: comment.isOptimistic
                                  ? 'linear-gradient(180deg, rgba(255,255,255,0.86), rgba(255,251,235,0.78))'
                                  : 'rgba(255,255,255,0.72)',
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text-strong)' }}>{comment.author}</span>
                                <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{formatAge(comment.createdAt)}</span>
                                {comment.line ? (
                                  <span style={{
                                    fontSize: 10,
                                    color: 'var(--t-text-secondary)',
                                    fontFamily: '"SF Mono", ui-monospace, monospace',
                                  }}>
                                    line {comment.line}
                                  </span>
                                ) : null}
                                {comment.isOptimistic ? (
                                  <span style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    paddingTop: 3,
                                    paddingRight: 8,
                                    paddingBottom: 3,
                                    paddingLeft: 8,
                                    borderRadius: 999,
                                    border: '1px solid rgba(245,158,11,0.18)',
                                    background: 'rgba(245,158,11,0.10)',
                                    color: '#b45309',
                                    fontSize: 10,
                                    fontWeight: 800,
                                  }}>
                                    Sending…
                                  </span>
                                ) : null}
                              </div>
                              <div style={{ fontSize: 13, lineHeight: 1.6, opacity: comment.isOptimistic ? 0.76 : 1 }}>
                                <MarkdownBody text={comment.body} />
                              </div>
                            </div>
                          ))}

                          <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 10,
                            flexWrap: 'wrap',
                          }}>
                            {onInjectChatContext ? (
                              <DesktopGlassActionChip
                                icon={addedContextKeys[threadKey] ? <Check size={12} strokeWidth={2.4} /> : <MessageSquare size={12} strokeWidth={2} />}
                                label={addedContextKeys[threadKey] ? 'Added to chat' : 'Add thread to chat'}
                                onClick={() => {
                                  injectPayload(
                                    threadKey,
                                    formatReviewThreadInjection({
                                      prNumber: pr.number,
                                      repo,
                                      status: thread.status,
                                      path: thread.path,
                                      line: thread.line,
                                      comments: thread.comments.map((comment) => ({
                                        prNumber: pr.number,
                                        repo,
                                        author: comment.author,
                                        body: comment.body,
                                        createdAt: comment.createdAt,
                                        path: comment.path,
                                        line: comment.line,
                                      })),
                                    }),
                                  );
                                  setViewedThreadIds((current) => ({ ...current, [thread.id]: true }));
                                }}
                                disabled={Boolean(addedContextKeys[threadKey])}
                              />
                            ) : <div />}

                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <button
                                type="button"
                                onClick={() => toggleViewedThread(thread.id)}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  gap: 6,
                                  minHeight: 44,
                                  paddingTop: 8,
                                  paddingRight: 14,
                                  paddingBottom: 8,
                                  paddingLeft: 14,
                                  borderRadius: 999,
                                  border: '1px solid rgba(148,163,184,0.22)',
                                  background: 'rgba(255,255,255,0.78)',
                                  color: isViewed ? '#475569' : '#b45309',
                                  fontSize: 12,
                                  fontWeight: 700,
                                  cursor: 'pointer',
                                  fontFamily: '-apple-system, system-ui, sans-serif',
                                }}
                              >
                                {isViewed ? 'Mark unviewed' : 'Mark viewed'}
                              </button>
                              {(thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve) ? (
                                <button
                                  type="button"
                                  onClick={() => { void submitThreadResolve(thread.id, !thread.isResolved); }}
                                  disabled={threadLoadingState === 'resolve' || threadLoadingState === 'unresolve'}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: 6,
                                    minHeight: 44,
                                    paddingTop: 8,
                                    paddingRight: 14,
                                    paddingBottom: 8,
                                    paddingLeft: 14,
                                    borderRadius: 999,
                                    border: `1px solid ${thread.isResolved ? 'rgba(96,165,250,0.22)' : 'rgba(22,163,74,0.18)'}`,
                                    background: thread.isResolved
                                      ? 'rgba(219,234,254,0.72)'
                                      : 'rgba(220,252,231,0.72)',
                                    color: thread.isResolved ? '#1d4ed8' : '#15803d',
                                    fontSize: 12,
                                    fontWeight: 700,
                                    cursor: threadLoadingState ? 'wait' : 'pointer',
                                    fontFamily: '-apple-system, system-ui, sans-serif',
                                    opacity: threadLoadingState ? 0.74 : 1,
                                  }}
                                >
                                  {threadLoadingState === 'resolve' || threadLoadingState === 'unresolve'
                                    ? 'Saving…'
                                    : thread.isResolved
                                      ? 'Reopen thread'
                                      : 'Resolve thread'}
                                </button>
                              ) : null}
                            </div>
                          </div>

                          {thread.viewerCanReply ? (
                            <div style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 10,
                              paddingTop: 12,
                              paddingRight: 14,
                              paddingBottom: 12,
                              paddingLeft: 14,
                              borderRadius: 16,
                              border: `1px solid ${tone.border}`,
                              background: 'rgba(255,255,255,0.78)',
                            }}>
                              <textarea
                                value={replyDrafts[thread.id] ?? ''}
                                onChange={(event) => setReplyDrafts((current) => ({ ...current, [thread.id]: event.target.value }))}
                                placeholder="Reply to this thread…"
                                rows={3}
                                style={{
                                  width: '100%',
                                  minHeight: 88,
                                  resize: 'vertical',
                                  border: '1px solid rgba(148,163,184,0.24)',
                                  borderRadius: 14,
                                  paddingTop: 10,
                                  paddingRight: 12,
                                  paddingBottom: 10,
                                  paddingLeft: 12,
                                  fontSize: 13,
                                  lineHeight: 1.5,
                                  background: 'rgba(248,250,252,0.92)',
                                  color: 'var(--t-text)',
                                  outline: 'none',
                                  fontFamily: '-apple-system, system-ui, sans-serif',
                                }}
                              />
                              <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 10,
                                flexWrap: 'wrap',
                              }}>
                                <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>
                                  {replyDrafts[thread.id]?.trim()
                                    ? `${replyDrafts[thread.id].trim().length} characters ready`
                                    : 'Draft stays local until the reply succeeds.'}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => { void submitThreadReply(thread.id); }}
                                  disabled={!replyDrafts[thread.id]?.trim() || threadLoadingState === 'reply'}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: 6,
                                    minHeight: 44,
                                    paddingTop: 8,
                                    paddingRight: 16,
                                    paddingBottom: 8,
                                    paddingLeft: 16,
                                    borderRadius: 999,
                                    border: '1px solid rgba(37,99,235,0.18)',
                                    background: !replyDrafts[thread.id]?.trim()
                                      ? 'rgba(148,163,184,0.18)'
                                      : threadLoadingState === 'reply'
                                        ? 'rgba(37,99,235,0.18)'
                                        : '#2563eb',
                                    color: !replyDrafts[thread.id]?.trim() ? 'var(--t-text-muted)' : '#fff',
                                    fontSize: 12,
                                    fontWeight: 800,
                                    cursor: !replyDrafts[thread.id]?.trim() ? 'default' : threadLoadingState === 'reply' ? 'wait' : 'pointer',
                                    fontFamily: '-apple-system, system-ui, sans-serif',
                                  }}
                                >
                                  <Send size={14} strokeWidth={2.2} />
                                  {threadLoadingState === 'reply' ? 'Sending…' : 'Reply'}
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
