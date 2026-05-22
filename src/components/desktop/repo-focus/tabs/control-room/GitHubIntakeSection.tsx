'use client';

import { CheckCircle2, GitPullRequest, Play, Plus, RefreshCw, Sparkles } from '../../../lucide-shims';
import type { GitHubIssueIntake } from './types';
import { issueKey } from './helpers';
import { IconActionButton } from './shared';

export function GitHubIntakeSection({
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
