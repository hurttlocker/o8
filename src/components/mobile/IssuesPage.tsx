'use client';

import { useState, useEffect, useCallback, memo, lazy, Suspense } from 'react';

const DeployStatus = lazy(() => import('./DeployStatus'));

interface Issue {
  number: number;
  title: string;
  state: string;
  labels: { name: string; color: string }[];
  author?: { login: string };
  body?: string;
  createdAt?: string;
}

interface PR {
  number: number;
  title: string;
  author: { login: string };
  headRefName: string;
  baseRefName: string;
  state: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  statusCheckRollup: { name: string; status: string; conclusion: string }[];
  reviewDecision: string;
  url: string;
  createdAt?: string;
}

interface IssuesPageProps {
  onBack: () => void;
  onOpenPR?: (repo: string, prNumber: number) => void;
}

const REPOS = ['hurttlocker/cortex-ide', 'hurttlocker/cortex'];

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function repoShort(repo: string): string {
  const map: Record<string, string> = {
    'hurttlocker/cortex-ide': 'Cortex IDE',
    'hurttlocker/cortex': 'Cortex',
    'LavonTMCQ/spear-production': 'Spear',
    'LavonTMCQ/mybeautifulwife': 'Antiflammi',
  };
  return map[repo] ?? repo.split('/').pop() ?? repo;
}

function checksRollup(checks: { status: string; conclusion: string }[]): { color: string; label: string } {
  if (!checks || checks.length === 0) return { color: '#8e8e93', label: 'No CI' };
  const failed = checks.some(c => c.conclusion === 'FAILURE');
  const pending = checks.some(c => c.status !== 'COMPLETED');
  if (failed) return { color: '#ff3b30', label: 'CI Failed' };
  if (pending) return { color: '#ff9f0a', label: 'CI Running' };
  return { color: '#34c759', label: 'CI Passed' };
}

const IssueCard = memo(function IssueCard({ issue, repo }: { issue: Issue; repo: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      role="button" tabIndex={0}
      onClick={() => setExpanded(!expanded)}
      onTouchEnd={(e) => { setExpanded(!expanded); e.preventDefault(); }}
      style={{
        padding: '12px 14px', borderRadius: 14,
        background: 'rgba(52,199,89,0.03)',
        border: '1px solid rgba(52,199,89,0.10)',
        cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="#34c759" strokeWidth="2" strokeLinecap="round"
          style={{ flexShrink: 0, marginTop: 2 }}>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#0a0a0a', lineHeight: 1.35, fontFamily: '-apple-system, system-ui, sans-serif' }}>
            {issue.title}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: '#8e8e93', fontFamily: '"SF Mono", ui-monospace, monospace' }}>#{issue.number}</span>
            <span style={{ fontSize: 10, color: '#8e8e93', padding: '1px 6px', borderRadius: 6, background: 'rgba(0,122,255,0.06)', fontWeight: 600 }}>
              {repoShort(repo)}
            </span>
            {issue.createdAt ? <span style={{ fontSize: 10, color: '#8e8e93' }}>{timeAgo(issue.createdAt)}</span> : null}
          </div>
        </div>
      </div>
      {issue.labels.length > 0 ? (
        <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
          {issue.labels.map(l => (
            <span key={l.name} style={{
              fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
              background: `#${l.color}18`, color: `#${l.color}`, border: `1px solid #${l.color}30`,
            }}>{l.name}</span>
          ))}
        </div>
      ) : null}
      {expanded && issue.body ? (
        <p style={{
          marginTop: 10, fontSize: 12, lineHeight: 1.5, color: '#3c3c43',
          whiteSpace: 'pre-wrap', display: '-webkit-box', WebkitLineClamp: 8,
          WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>{issue.body.slice(0, 600)}</p>
      ) : null}
    </div>
  );
});

const PRCard = memo(function PRCard({ pr, repo, onOpen }: { pr: PR; repo: string; onOpen: () => void }) {
  const ci = checksRollup(pr.statusCheckRollup);

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
      onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); onOpen(); }}
      style={{
        width: '100%', padding: '12px 14px', borderRadius: 14,
        background: 'rgba(0,122,255,0.03)',
        border: '1px solid rgba(0,122,255,0.10)',
        cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation', textAlign: 'left',
        display: 'block',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        {/* PR icon */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="#007aff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink: 0, marginTop: 2 }}>
          <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" />
          <path d="M13 6h3a2 2 0 0 1 2 2v7" /><line x1="6" y1="9" x2="6" y2="21" />
        </svg>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#0a0a0a', lineHeight: 1.35, fontFamily: '-apple-system, system-ui, sans-serif' }}>
            {pr.title}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: '#8e8e93', fontFamily: '"SF Mono", ui-monospace, monospace' }}>#{pr.number}</span>
            <span style={{ fontSize: 10, color: '#8e8e93', padding: '1px 6px', borderRadius: 6, background: 'rgba(0,122,255,0.06)', fontWeight: 600 }}>
              {repoShort(repo)}
            </span>
            <span style={{ fontSize: 10, color: '#636366' }}>{pr.headRefName}</span>
          </div>
        </div>
        {/* CI badge */}
        <span style={{
          fontSize: 9, fontWeight: 700, padding: '3px 8px', borderRadius: 8,
          background: `${ci.color}12`, color: ci.color,
          whiteSpace: 'nowrap', flexShrink: 0,
        }}>
          {ci.label}
        </span>
      </div>
      {/* Diff stats */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, marginLeft: 22 }}>
        <span style={{ fontSize: 11, color: '#8e8e93' }}>{pr.changedFiles} files</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#34c759', fontFamily: '"SF Mono", monospace' }}>+{pr.additions}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#ff3b30', fontFamily: '"SF Mono", monospace' }}>-{pr.deletions}</span>
        {pr.reviewDecision ? (
          <span style={{
            fontSize: 9, fontWeight: 600, marginLeft: 'auto',
            color: pr.reviewDecision === 'APPROVED' ? '#34c759' : pr.reviewDecision === 'CHANGES_REQUESTED' ? '#ff3b30' : '#ff9f0a',
          }}>
            {pr.reviewDecision === 'APPROVED' ? 'Approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes req.' : 'Review needed'}
          </span>
        ) : null}
      </div>
    </button>
  );
});

export default function IssuesPage({ onBack, onOpenPR }: IssuesPageProps) {
  const [issues, setIssues] = useState<{ issue: Issue; repo: string }[]>([]);
  const [prs, setPRs] = useState<{ pr: PR; repo: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'all' | 'issues' | 'prs'>('all');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const issueResults: { issue: Issue; repo: string }[] = [];
    const prResults: { pr: PR; repo: string }[] = [];

    await Promise.all(
      REPOS.map(async (repo) => {
        // Fetch issues
        try {
          const res = await fetch(`/api/panel/issues?repo=${encodeURIComponent(repo)}`);
          const data = await res.json();
          for (const issue of data.issues ?? []) {
            issueResults.push({ issue, repo });
          }
        } catch {}

        // Fetch PRs
        try {
          const res = await fetch(`/api/panel/prs?repo=${encodeURIComponent(repo)}`);
          const data = await res.json();
          for (const pr of data.prs ?? []) {
            prResults.push({ pr, repo });
          }
        } catch {}
      })
    );

    issueResults.sort((a, b) => b.issue.number - a.issue.number);
    prResults.sort((a, b) => b.pr.number - a.pr.number);
    setIssues(issueResults);
    setPRs(prResults);
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const tabs: { key: typeof activeTab; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: issues.length + prs.length },
    { key: 'prs', label: 'Pull Requests', count: prs.length },
    { key: 'issues', label: 'Issues', count: issues.length },
  ];

  return (
    <div style={{ padding: '0 12px 24px', width: '100%', boxSizing: 'border-box' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h1 style={{
            fontSize: 28, fontWeight: 800, letterSpacing: '-0.03em', color: '#0a0a0a',
            fontFamily: '-apple-system, system-ui, sans-serif', margin: 0,
          }}>
            Issues & PRs
          </h1>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: '#8e8e93', fontWeight: 500 }}>
            {loading ? 'Loading...' : `${issues.length} issues · ${prs.length} PRs`}
          </p>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{
        display: 'flex', padding: 3, borderRadius: 10,
        background: 'rgba(0,122,255,0.04)', border: '1px solid rgba(0,122,255,0.08)',
        gap: 1, marginBottom: 16,
      }}>
        {tabs.map(tab => (
          <button key={tab.key} type="button"
            onClick={() => setActiveTab(tab.key)}
            onTouchEnd={(e) => { setActiveTab(tab.key); e.preventDefault(); }}
            style={{
              flex: 1, padding: '7px 4px', borderRadius: 8, border: 'none',
              background: activeTab === tab.key ? '#fff' : 'transparent',
              boxShadow: activeTab === tab.key ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
              cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
              transition: 'all 200ms ease',
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 600, color: activeTab === tab.key ? '#0a0a0a' : '#8e8e93' }}>
              {tab.label}
            </span>
            <span style={{
              minWidth: 14, height: 14, borderRadius: 7, padding: '0 3px',
              background: activeTab === tab.key ? '#007aff' : 'rgba(0,0,0,0.06)',
              color: activeTab === tab.key ? '#fff' : '#8e8e93',
              fontSize: 9, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#8e8e93', fontSize: 14 }}>
            Loading...
          </div>
        ) : (
          <>
            {/* PRs section */}
            {(activeTab === 'all' || activeTab === 'prs') && prs.length > 0 ? (
              <>
                {activeTab === 'all' ? (
                  <h2 style={{
                    fontSize: 15, fontWeight: 700, color: '#0a0a0a', margin: '8px 0 4px',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                  }}>
                    Pull Requests
                  </h2>
                ) : null}
                {prs.map(({ pr, repo }) => (
                  <PRCard key={`pr-${repo}-${pr.number}`} pr={pr} repo={repo}
                    onOpen={() => onOpenPR?.(repo, pr.number)}
                  />
                ))}
              </>
            ) : null}

            {/* Issues section */}
            {(activeTab === 'all' || activeTab === 'issues') && issues.length > 0 ? (
              <>
                {activeTab === 'all' ? (
                  <h2 style={{
                    fontSize: 15, fontWeight: 700, color: '#0a0a0a', margin: '16px 0 4px',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                  }}>
                    Issues
                  </h2>
                ) : null}
                {issues.map(({ issue, repo }) => (
                  <IssueCard key={`issue-${repo}-${issue.number}`} issue={issue} repo={repo} />
                ))}
              </>
            ) : null}

            {(activeTab === 'all' || activeTab === 'prs') && prs.length === 0 && activeTab === 'prs' ? (
              <div style={{ padding: 32, textAlign: 'center', color: '#8e8e93', fontSize: 14 }}>No open PRs</div>
            ) : null}
            {(activeTab === 'all' || activeTab === 'issues') && issues.length === 0 && activeTab === 'issues' ? (
              <div style={{ padding: 32, textAlign: 'center', color: '#8e8e93', fontSize: 14 }}>No open issues</div>
            ) : null}
          </>
        )}
      </div>

      {/* Deployments */}
      <div style={{ marginTop: 24 }}>
        <h2 style={{
          fontSize: 17, fontWeight: 700, color: '#0a0a0a',
          fontFamily: '-apple-system, system-ui, sans-serif',
          letterSpacing: '-0.02em', margin: '0 0 10px',
        }}>
          Deployments
        </h2>
        <Suspense fallback={<div style={{ padding: 20, textAlign: 'center', color: '#8e8e93', fontSize: 13 }}>Loading...</div>}>
          <DeployStatus />
        </Suspense>
      </div>
    </div>
  );
}
