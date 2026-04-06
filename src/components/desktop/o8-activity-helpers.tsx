'use client';

/**
 * o8-activity-helpers — Icons, data-fetching, and render helpers for O8ActivityPane.
 * Extracted to keep the main component under 800 lines.
 */

import type { ActivityItem, FeedFilter } from './agent-panel/types';
import { relativeAge } from './agent-panel/shared';

// ── Phosphor-style SVG icons (raw, per CLAUDE.md) ──

export function IconZap({ size = 11, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

export function IconAlertCircle({ size = 11, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

export function IconGitPullRequest({ size = 11, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <line x1="6" y1="9" x2="6" y2="21" />
    </svg>
  );
}

export function IconGitCommit({ size = 11, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="4" />
      <line x1="1.05" y1="12" x2="7" y2="12" />
      <line x1="17.01" y1="12" x2="22.96" y2="12" />
    </svg>
  );
}

export function IconCheckCircle({ size = 11, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

export function IconXCircle({ size = 11, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

export function IconClock({ size = 11, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

export function IconFolder({ size = 11, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function IconChevronDown({ size = 10, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// ── Constants ──

export type O8FeedFilter = FeedFilter;

export const ALL_REPOS_KEY = '__all__';

export const FILTER_TABS: { key: O8FeedFilter; label: string; icon: (color: string) => React.ReactNode }[] = [
  { key: 'all', label: 'All', icon: (c) => <IconZap size={11} color={c} /> },
  { key: 'commit', label: 'Commits', icon: (c) => <IconGitCommit size={11} color={c} /> },
  { key: 'pr', label: 'PRs', icon: (c) => <IconGitPullRequest size={11} color={c} /> },
  { key: 'issue', label: 'Issues', icon: (c) => <IconAlertCircle size={11} color={c} /> },
  { key: 'ci', label: 'CI', icon: (c) => <IconCheckCircle size={11} color={c} /> },
];

const FEED_ICON_MAP: Record<string, { bg: string; color: string; icon: React.ReactNode }> = {
  commit: { bg: 'rgba(34,197,94,0.08)', color: '#22c55e', icon: <IconGitCommit size={11} color="#22c55e" /> },
  issue: { bg: 'rgba(139,92,246,0.08)', color: '#8b5cf6', icon: <IconAlertCircle size={11} color="#8b5cf6" /> },
  pr: { bg: 'rgba(37,99,235,0.08)', color: '#2563eb', icon: <IconGitPullRequest size={11} color="#2563eb" /> },
  ci_success: { bg: 'rgba(34,197,94,0.08)', color: '#22c55e', icon: <IconCheckCircle size={11} color="#22c55e" /> },
  ci_failure: { bg: 'rgba(239,68,68,0.08)', color: '#ef4444', icon: <IconXCircle size={11} color="#ef4444" /> },
  ci_pending: { bg: 'rgba(245,158,11,0.08)', color: '#f59e0b', icon: <IconClock size={11} color="#f59e0b" /> },
};

export function feedIconForItem(item: ActivityItem) {
  if (item.kind === 'ci') {
    if (item.conclusion === 'success') return FEED_ICON_MAP.ci_success;
    if (item.conclusion === 'failure') return FEED_ICON_MAP.ci_failure;
    return FEED_ICON_MAP.ci_pending;
  }
  return FEED_ICON_MAP[item.kind] ?? FEED_ICON_MAP.commit;
}

// ── Data Fetching ──

export interface RepoActivityData {
  commits: ActivityItem[];
  prs: ActivityItem[];
  issues: ActivityItem[];
  ciRuns: ActivityItem[];
}

export const EMPTY_DATA: RepoActivityData = { commits: [], prs: [], issues: [], ciRuns: [] };

export async function fetchRepoActivity(repoSlug: string): Promise<RepoActivityData> {
  const enc = encodeURIComponent(repoSlug);
  const [commitsRes, prsRes, issuesRes, ciRes] = await Promise.all([
    fetch(`/api/panel/commits?repo=${enc}`).catch(() => null),
    fetch(`/api/panel/prs?repo=${enc}`).catch(() => null),
    fetch(`/api/panel/issues?repo=${enc}`).catch(() => null),
    fetch(`/api/panel/ci?repo=${enc}`).catch(() => null),
  ]);

  const commits: ActivityItem[] = [];
  if (commitsRes?.ok) {
    const data = await commitsRes.json();
    for (const c of (data.commits ?? []).slice(0, 12)) {
      const ts = c.date ? new Date(c.date).getTime() : 0;
      commits.push({ kind: 'commit', hash: c.hash ?? '', message: c.message ?? '', age: c.date ? relativeAge(c.date) : '', ts, repo: repoSlug });
    }
  }

  const prs: ActivityItem[] = [];
  if (prsRes?.ok) {
    const data = await prsRes.json();
    for (const pr of (data.prs ?? []).slice(0, 8)) {
      const ts = pr.createdAt ? new Date(pr.createdAt).getTime() : 0;
      const checks = pr.statusCheckRollup ?? [];
      prs.push({
        kind: 'pr',
        number: pr.number,
        title: pr.title,
        state: (pr.state ?? '').toLowerCase(),
        author: pr.author?.login ?? '',
        branch: pr.headRefName ?? '',
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        changedFiles: pr.changedFiles ?? 0,
        reviewDecision: pr.reviewDecision ?? '',
        checkSummary: {
          passed: checks.filter((ch: { conclusion?: string | null }) => ch.conclusion?.toLowerCase() === 'success').length,
          failed: checks.filter((ch: { conclusion?: string | null }) => ch.conclusion?.toLowerCase() === 'failure').length,
          pending: checks.filter((ch: { conclusion?: string | null; status?: string | null }) => !ch.conclusion || ch.status?.toLowerCase() !== 'completed').length,
        },
        age: pr.createdAt ? relativeAge(pr.createdAt) : '',
        ts,
        repo: repoSlug,
      });
    }
  }

  const issues: ActivityItem[] = [];
  if (issuesRes?.ok) {
    const data = await issuesRes.json();
    for (const issue of (data.issues ?? []).slice(0, 8)) {
      const ts = issue.createdAt ? new Date(issue.createdAt).getTime() : 0;
      issues.push({
        kind: 'issue',
        number: issue.number,
        title: issue.title,
        state: (issue.state ?? '').toLowerCase(),
        labels: issue.labels ?? [],
        age: issue.createdAt ? relativeAge(issue.createdAt) : '',
        ts,
        repo: repoSlug,
        author: issue.author?.login ?? 'unknown',
        assignees: (issue.assignees ?? []).map((a: { login?: string | null }) => a.login ?? '').filter(Boolean),
        comments: typeof issue.comments === 'number' ? issue.comments : 0,
        body: (issue.body ?? '').trim(),
      });
    }
  }

  const ciRuns: ActivityItem[] = [];
  if (ciRes?.ok) {
    const data = await ciRes.json();
    for (const run of (data.runs ?? []).slice(0, 6)) {
      const ts = run.createdAt ? new Date(run.createdAt).getTime() : 0;
      ciRuns.push({
        kind: 'ci',
        id: run.databaseId,
        title: run.displayTitle ?? '',
        status: run.status ?? '',
        conclusion: run.conclusion ?? '',
        branch: run.headBranch ?? '',
        workflow: run.workflowName ?? '',
        age: run.createdAt ? relativeAge(run.createdAt) : '',
        ts,
        repo: repoSlug,
      });
    }
  }

  return { commits, prs, issues, ciRuns };
}

// ── Render helpers ──

export function itemKey(item: ActivityItem): string {
  if (item.kind === 'commit') return `c-${item.repo ?? 'local'}-${item.hash}`;
  if (item.kind === 'event') return `e-${item.data.id}`;
  if (item.kind === 'issue') return `i-${item.repo}-${item.number}`;
  if (item.kind === 'pr') return `pr-${item.repo}-${item.number}`;
  return `ci-${item.repo}-${item.id}`;
}

export function itemTitle(item: ActivityItem): string {
  if (item.kind === 'commit') return item.message;
  if (item.kind === 'event') return item.data.title;
  if (item.kind === 'issue') return `#${item.number} ${item.title}`;
  if (item.kind === 'pr') return `#${item.number} ${item.title}`;
  return item.title;
}

export function itemSubline(item: ActivityItem): React.ReactNode {
  if (item.kind === 'commit') {
    return (
      <>
        <span style={{ color: 'var(--t-text-secondary)' }}>{item.hash}</span>
        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
        <span>{item.age}</span>
      </>
    );
  }
  if (item.kind === 'pr') {
    return (
      <>
        <span style={{ color: '#22c55e' }}>+{item.additions}</span>
        <span style={{ color: '#ef4444' }}>-{item.deletions}</span>
        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
        <span>{item.branch}</span>
        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
        <span>{item.age}</span>
      </>
    );
  }
  if (item.kind === 'ci') {
    return (
      <>
        <span>{item.workflow}</span>
        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
        <span>{item.branch}</span>
        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
        <span style={{
          color: item.conclusion === 'success' ? '#22c55e' : item.conclusion === 'failure' ? '#ef4444' : '#f59e0b',
          fontWeight: 600,
        }}>
          {item.conclusion || item.status}
        </span>
      </>
    );
  }
  if (item.kind === 'issue') {
    return (
      <>
        {item.labels.slice(0, 2).map((label) => (
          <span
            key={label.name}
            style={{
              paddingTop: 0,
              paddingRight: 4,
              paddingBottom: 0,
              paddingLeft: 4,
              borderRadius: 4,
              background: `#${label.color}18`,
              color: `#${label.color}`,
              fontSize: 9,
              fontWeight: 600,
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            {label.name}
          </span>
        ))}
        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
        <span>{item.age}</span>
      </>
    );
  }
  return null;
}

export function itemBadge(item: ActivityItem): React.ReactNode {
  if (item.kind === 'pr' && item.state) {
    return (
      <span style={{
        paddingTop: 1,
        paddingRight: 6,
        paddingBottom: 1,
        paddingLeft: 6,
        borderRadius: 999,
        fontSize: 9,
        fontWeight: 700,
        flexShrink: 0,
        marginTop: 4,
        background: item.state === 'merged' ? 'rgba(139,92,246,0.1)' : item.state === 'open' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
        color: item.state === 'merged' ? '#8b5cf6' : item.state === 'open' ? '#22c55e' : '#ef4444',
        textTransform: 'uppercase',
        fontFamily: '-apple-system, system-ui, sans-serif',
      }}>
        {item.state}
      </span>
    );
  }
  if (item.kind === 'issue' && item.state) {
    return (
      <span style={{
        paddingTop: 1,
        paddingRight: 6,
        paddingBottom: 1,
        paddingLeft: 6,
        borderRadius: 999,
        fontSize: 9,
        fontWeight: 700,
        flexShrink: 0,
        marginTop: 4,
        background: item.state === 'open' ? 'rgba(34,197,94,0.1)' : 'rgba(139,92,246,0.1)',
        color: item.state === 'open' ? '#22c55e' : '#8b5cf6',
        textTransform: 'uppercase',
        fontFamily: '-apple-system, system-ui, sans-serif',
      }}>
        {item.state}
      </span>
    );
  }
  return null;
}
