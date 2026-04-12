import React, { memo } from 'react';
import type { PRDetail, ReviewThread, ReviewThreadStatus, PersistedReviewThreadUiState, ReviewThreadTone } from './types';
import { REVIEW_THREAD_STORAGE_VERSION, REVIEW_THREAD_CLIENT_RETRY_DELAYS_MS } from './constants';

/* ------------------------------------------------------------------ */
/*  ReviewThreadClientError                                            */
/* ------------------------------------------------------------------ */

export class ReviewThreadClientError extends Error {
  readonly status: number | null;

  constructor(message: string, status?: number | null) {
    super(message);
    this.name = 'ReviewThreadClientError';
    this.status = status ?? null;
  }
}

/* ------------------------------------------------------------------ */
/*  Normalization helpers                                              */
/* ------------------------------------------------------------------ */

export function deriveReviewThreadStatus(thread: { isResolved: boolean; isOutdated: boolean }): ReviewThreadStatus {
  if (thread.isResolved) return 'resolved';
  if (thread.isOutdated) return 'outdated';
  return 'active';
}

export function normalizeReviewThread(thread: ReviewThread): ReviewThread {
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

export function normalizeReviewThreads(threads: ReviewThread[]) {
  return threads
    .map(normalizeReviewThread)
    .sort((left, right) => new Date(right.latestCommentAt).getTime() - new Date(left.latestCommentAt).getTime());
}

export function normalizePRDetail(pr: PRDetail): PRDetail {
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

/* ------------------------------------------------------------------ */
/*  Storage helpers                                                    */
/* ------------------------------------------------------------------ */

export function buildReviewThreadStorageKey(repo: string | undefined, prNumber: number) {
  return `cortex.pr-review-thread-ui.v${REVIEW_THREAD_STORAGE_VERSION}:${repo ?? 'unknown'}:${prNumber}`;
}

export function readPersistedReviewThreadUiState(storageKey: string): PersistedReviewThreadUiState {
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

export function toThreadPreferenceMap(ids: string[]) {
  return ids.reduce<Record<string, true>>((accumulator, id) => {
    accumulator[id] = true;
    return accumulator;
  }, {});
}

/* ------------------------------------------------------------------ */
/*  Review thread API helpers                                          */
/* ------------------------------------------------------------------ */

export function isRetryableReviewThreadError(error: unknown) {
  if (error instanceof ReviewThreadClientError) {
    return error.status === 429 || (error.status !== null && error.status >= 500);
  }

  if (!(error instanceof Error)) return false;
  return /failed to fetch|network|timeout|timed out/i.test(error.message);
}

async function waitForReviewThreadRetry(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function requestReviewThreadApi<T extends Record<string, unknown>>(url: string, init?: RequestInit) {
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

/* ------------------------------------------------------------------ */
/*  Formatting helpers                                                 */
/* ------------------------------------------------------------------ */

export function formatReviewThreadLocation(thread: ReviewThread) {
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

export function reviewThreadTone(status: ReviewThreadStatus): ReviewThreadTone {
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

export function createDesktopGlassActionStyle(variant: 'primary' | 'muted' = 'primary') {
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
    fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
  } as React.CSSProperties;
}

/* ------------------------------------------------------------------ */
/*  DesktopGlassActionChip                                             */
/* ------------------------------------------------------------------ */

function DesktopGlassActionChipBase({
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

export const DesktopGlassActionChip = memo(DesktopGlassActionChipBase);
