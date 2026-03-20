'use client';

import { useState, useEffect, useCallback, memo } from 'react';

interface Issue {
  number: number;
  title: string;
  state: string;
  labels: { name: string; color: string }[];
  author?: { login: string };
  body?: string;
  createdAt?: string;
  comments?: number;
}

interface IssuesPageProps {
  onBack: () => void;
  repos?: string[];
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

function labelColor(hex: string): string {
  // Convert GitHub hex to rgba
  return `#${hex}`;
}

const IssueCard = memo(function IssueCard({ issue, repo }: { issue: Issue; repo: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setExpanded(!expanded)}
      onTouchEnd={(e) => { setExpanded(!expanded); e.preventDefault(); }}
      style={{
        padding: '12px 14px',
        borderRadius: 14,
        background: 'rgba(0,122,255,0.03)',
        border: '1px solid rgba(0,122,255,0.08)',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        {/* Issue icon */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="#34c759" strokeWidth="2" strokeLinecap="round"
          style={{ flexShrink: 0, marginTop: 2 }}>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 14, fontWeight: 600, color: '#0a0a0a',
            lineHeight: 1.35,
            fontFamily: '-apple-system, system-ui, sans-serif',
          }}>
            {issue.title}
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            marginTop: 4, flexWrap: 'wrap',
          }}>
            <span style={{
              fontSize: 11, color: '#8e8e93',
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}>
              #{issue.number}
            </span>
            <span style={{
              fontSize: 10, color: '#8e8e93',
              padding: '1px 6px', borderRadius: 6,
              background: 'rgba(0,122,255,0.06)',
              fontWeight: 600,
            }}>
              {repoShort(repo)}
            </span>
            {issue.createdAt ? (
              <span style={{ fontSize: 10, color: '#8e8e93' }}>
                {timeAgo(issue.createdAt)}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Labels */}
      {issue.labels.length > 0 ? (
        <div style={{
          display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap',
        }}>
          {issue.labels.map(l => (
            <span key={l.name} style={{
              fontSize: 10, fontWeight: 600,
              padding: '2px 8px', borderRadius: 10,
              background: `${labelColor(l.color)}18`,
              color: labelColor(l.color),
              border: `1px solid ${labelColor(l.color)}30`,
            }}>
              {l.name}
            </span>
          ))}
        </div>
      ) : null}

      {/* Expanded body */}
      {expanded && issue.body ? (
        <p style={{
          marginTop: 10, fontSize: 12, lineHeight: 1.5,
          color: '#3c3c43',
          fontFamily: '-apple-system, system-ui, sans-serif',
          whiteSpace: 'pre-wrap',
          display: '-webkit-box', WebkitLineClamp: 8,
          WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>
          {issue.body.slice(0, 600)}
        </p>
      ) : null}
    </div>
  );
});

export default function IssuesPage({ onBack, repos }: IssuesPageProps) {
  const [issues, setIssues] = useState<{ issue: Issue; repo: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRepo, setSelectedRepo] = useState<string>('all');
  const repoList = repos ?? REPOS;

  const fetchIssues = useCallback(async () => {
    setLoading(true);
    const results: { issue: Issue; repo: string }[] = [];
    await Promise.all(
      repoList.map(async (repo) => {
        try {
          const res = await fetch(`/api/panel/issues?repo=${encodeURIComponent(repo)}`);
          const data = await res.json();
          for (const issue of data.issues ?? []) {
            results.push({ issue, repo });
          }
        } catch {}
      })
    );
    results.sort((a, b) => (b.issue.number) - (a.issue.number));
    setIssues(results);
    setLoading(false);
  }, [repoList]);

  useEffect(() => { fetchIssues(); }, [fetchIssues]);

  const filtered = selectedRepo === 'all'
    ? issues
    : issues.filter(i => i.repo === selectedRepo);

  return (
    <div style={{ padding: '0 12px 24px', width: '100%', boxSizing: 'border-box' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 16,
      }}>
        <div>
          <h1 style={{
            fontSize: 28, fontWeight: 800,
            letterSpacing: '-0.03em', color: '#0a0a0a',
            fontFamily: '-apple-system, system-ui, sans-serif',
            margin: 0,
          }}>
            Issues
          </h1>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: '#8e8e93', fontWeight: 500 }}>
            {loading ? 'Loading...' : `${filtered.length} open`}
          </p>
        </div>
      </div>

      {/* Repo filter */}
      <div style={{
        display: 'flex', padding: 3,
        borderRadius: 10,
        background: 'rgba(0,122,255,0.04)',
        border: '1px solid rgba(0,122,255,0.08)',
        gap: 1, marginBottom: 16,
        overflowX: 'auto',
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none',
      }}>
        <RepoTab id="all" label="All" active={selectedRepo === 'all'} onSelect={setSelectedRepo} count={issues.length} />
        {repoList.map(r => (
          <RepoTab key={r} id={r} label={repoShort(r)}
            active={selectedRepo === r} onSelect={setSelectedRepo}
            count={issues.filter(i => i.repo === r).length}
          />
        ))}
      </div>

      {/* Issues list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#8e8e93', fontSize: 14 }}>
            Loading issues...
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#8e8e93', fontSize: 14 }}>
            No open issues
          </div>
        ) : (
          filtered.map(({ issue, repo }) => (
            <IssueCard key={`${repo}-${issue.number}`} issue={issue} repo={repo} />
          ))
        )}
      </div>
    </div>
  );
}

function RepoTab({ id, label, active, onSelect, count }: {
  id: string; label: string; active: boolean; onSelect: (id: string) => void; count: number;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      onTouchEnd={(e) => { onSelect(id); e.preventDefault(); }}
      style={{
        flex: '1 0 auto', padding: '7px 8px',
        borderRadius: 8, border: 'none',
        background: active ? '#fff' : 'transparent',
        boxShadow: active ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
        cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
        transition: 'all 200ms ease',
      }}
    >
      <span style={{
        fontSize: 11, fontWeight: 600,
        color: active ? '#0a0a0a' : '#8e8e93',
      }}>
        {label}
      </span>
      <span style={{
        minWidth: 14, height: 14, borderRadius: 7, padding: '0 3px',
        background: active ? '#007aff' : 'rgba(0,0,0,0.06)',
        color: active ? '#fff' : '#8e8e93',
        fontSize: 9, fontWeight: 700,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {count}
      </span>
    </button>
  );
}
