'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReviewChangedFile, WorkflowReviewSnapshot } from '@/lib/fleet/types';

function statusClass(status: string) {
  return `status-pill status-${status}`;
}

function fileStatusLabel(status: ReviewChangedFile['status']) {
  switch (status) {
    case 'modified':
      return 'modified';
    case 'added':
      return 'added';
    case 'deleted':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    case 'untracked':
      return 'untracked';
    default:
      return status;
  }
}

function fileStatusTone(status: ReviewChangedFile['status']) {
  switch (status) {
    case 'added':
      return 'healthy';
    case 'deleted':
      return 'critical';
    case 'untracked':
      return 'warning';
    case 'renamed':
      return 'reviewing';
    case 'modified':
    default:
      return 'running';
  }
}

function formatDelta(value?: number | null, prefix = '+') {
  if (value == null) return '—';
  return `${prefix}${value}`;
}

async function readJson<T>(response: Response) {
  const payload = (await response.json().catch(() => null)) as T | { error?: string } | null;
  if (!response.ok) {
    const errorMessage =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `HTTP ${response.status}`;
    throw new Error(errorMessage);
  }

  return payload as T;
}

export function WorkflowReviewPanel({ initialSnapshot }: { initialSnapshot?: WorkflowReviewSnapshot | null }) {
  const [snapshot, setSnapshot] = useState<WorkflowReviewSnapshot | null>(initialSnapshot ?? null);
  const [loading, setLoading] = useState(!initialSnapshot);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/review/workspace', {
        cache: 'no-store',
      });
      const payload = await readJson<WorkflowReviewSnapshot>(response);
      setSnapshot(payload);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to refresh review surface');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;

    async function safeRefresh() {
      if (!active) return;
      await refresh();
    }

    void safeRefresh();
    const timer = window.setInterval(() => {
      void safeRefresh();
    }, 45000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const warnings = snapshot?.warnings?.filter(Boolean) ?? [];
  const changedFiles = snapshot?.changedFiles ?? [];
  const pullRequests = snapshot?.pullRequests ?? [];
  const worktrees = snapshot?.worktrees ?? [];
  const activeIssues = snapshot?.activeIssues ?? [];

  return (
    <section className="surface-card workflow-review-surface">
      <div className="section-head">
        <div>
          <div className="eyebrow">Workflow surface</div>
          <h2>Git / GitHub / worktree review</h2>
        </div>
        <div className="workflow-review-actions">
          <span className={statusClass(snapshot?.dirty ? 'warning' : 'healthy')}>
            {loading && !snapshot ? 'loading' : snapshot?.dirty ? `${changedFiles.length} changed` : 'clean'}
          </span>
          <button type="button" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh review'}
          </button>
        </div>
      </div>

      <div className="summary-grid workflow-summary-grid">
        <div className="surface-card metric-card">
          <span>Repo</span>
          <strong>{snapshot?.repoSlug ?? 'Loading…'}</strong>
          <p>{snapshot?.repoPath ?? 'Locating active repo root…'}</p>
        </div>
        <div className="surface-card metric-card">
          <span>Branch</span>
          <strong className="mono">{snapshot?.branch ?? '—'}</strong>
          <p>
            {snapshot?.upstream ? `${snapshot.upstream} • +${snapshot.ahead} / -${snapshot.behind}` : 'No upstream branch detected yet.'}
          </p>
        </div>
        <div className="surface-card metric-card">
          <span>Active issues</span>
          <strong>{activeIssues.length || 'Not linked'}</strong>
          <p>
            {activeIssues.length
              ? activeIssues.map((issue) => `#${issue.number}`).join(' • ')
              : 'Issue linkage not loaded yet.'}
          </p>
        </div>
        <div className="surface-card metric-card">
          <span>Open PRs</span>
          <strong>{pullRequests.length}</strong>
          <p>{pullRequests[0] ? `Current lane: #${pullRequests[0].number}` : 'No branch PR attached yet.'}</p>
        </div>
      </div>

      {error ? <p className="muted workflow-note">{error}</p> : null}
      {warnings.length ? (
        <div className="workflow-warning-list">
          {warnings.map((warning) => (
            <p key={warning} className="muted workflow-note">
              {warning}
            </p>
          ))}
        </div>
      ) : null}

      <div className="workflow-grid">
        <div className="inset-card inspector-block">
          <div className="row space-between compact-row operator-header-row">
            <div>
              <span>Changed surfaces</span>
              <strong>Bounded review queue</strong>
            </div>
            <span className={statusClass(changedFiles.length ? 'reviewing' : 'healthy')}>
              {changedFiles.length} files
            </span>
          </div>
          {changedFiles.length ? (
            <div className="workflow-file-list">
              {changedFiles.slice(0, 12).map((file) => (
                <div key={`${file.status}:${file.path}`} className="workflow-file-item">
                  <div className="row space-between compact-row">
                    <strong className="mono">{file.path}</strong>
                    <span className={statusClass(fileStatusTone(file.status))}>{fileStatusLabel(file.status)}</span>
                  </div>
                  <p className="muted mono">
                    {formatDelta(file.additions)} / {formatDelta(file.deletions, '-')}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted workflow-note">Working tree is clean. No bounded diff surface is waiting locally.</p>
          )}
        </div>

        <div className="inset-card inspector-block">
          <div className="row space-between compact-row operator-header-row">
            <div>
              <span>GitHub + worktrees</span>
              <strong>Operator linkage</strong>
            </div>
            <span className={statusClass(worktrees.length > 1 ? 'running' : 'healthy')}>
              {worktrees.length} worktree{worktrees.length === 1 ? '' : 's'}
            </span>
          </div>

          <div className="workflow-issue-card">
            <span>Issue stack</span>
            {activeIssues.length ? (
              <div className="workflow-pr-list">
                {activeIssues.map((issue) => (
                  <a key={issue.number} href={issue.url} target="_blank" rel="noreferrer">
                    <div className="workflow-pr-item">
                      <div className="row space-between compact-row">
                        <strong>{`#${issue.number} — ${issue.title}`}</strong>
                        <span className={statusClass(issue.state.toLowerCase() === 'open' ? 'reviewing' : 'healthy')}>
                          {issue.state.toLowerCase()}
                        </span>
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            ) : (
              <strong>Issue linkage unavailable</strong>
            )}
          </div>

          <div className="workflow-pr-list">
            {pullRequests.length ? (
              pullRequests.map((pullRequest) => (
                <a key={pullRequest.number} href={pullRequest.url} target="_blank" rel="noreferrer">
                  <div className="workflow-pr-item">
                    <div className="row space-between compact-row">
                      <strong>{`#${pullRequest.number} — ${pullRequest.title}`}</strong>
                      <span className={statusClass(pullRequest.isDraft ? 'warning' : 'reviewing')}>
                        {pullRequest.isDraft ? 'draft' : pullRequest.reviewDecision ?? pullRequest.state.toLowerCase()}
                      </span>
                    </div>
                    <p className="muted mono">
                      {pullRequest.headRefName} → {pullRequest.baseRefName}
                    </p>
                  </div>
                </a>
              ))
            ) : (
              <p className="muted workflow-note">No open PR is attached to the current branch yet.</p>
            )}
          </div>

          <div className="workflow-worktree-list">
            {worktrees.map((worktree) => (
              <div key={`${worktree.path}:${worktree.branch ?? worktree.head}`} className="workflow-worktree-item">
                <div className="row space-between compact-row">
                  <strong className="mono">{worktree.branch ?? 'detached'}</strong>
                  {worktree.isCurrent ? <span className={statusClass('healthy')}>current</span> : null}
                </div>
                <p className="muted mono">{worktree.path}</p>
                <p className="muted mono">
                  {worktree.head ?? 'unknown head'}
                  {worktree.lockedReason ? ` • locked` : ''}
                  {worktree.prunableReason ? ` • prunable` : ''}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="inset-card inspector-block">
        <div className="row space-between compact-row operator-header-row">
          <div>
            <span>Diff stat</span>
            <strong>Reviewable output</strong>
          </div>
          <span className={statusClass(changedFiles.length ? 'running' : 'healthy')}>git diff --stat</span>
        </div>
        <pre className="terminal-preview">{snapshot?.diffStat ?? 'Loading diff surface…'}</pre>
        {snapshot?.recentCommits?.length ? (
          <div className="workflow-commit-list">
            {snapshot.recentCommits.map((commit) => (
              <div key={commit} className="workflow-commit-item mono">
                {commit}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
