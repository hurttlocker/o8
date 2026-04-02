'use client';

import { Suspense, lazy, memo, useCallback, useEffect, useState } from 'react';
import { useTheme } from './ThemeContext';

const DeployStatus = lazy(() => import('./DeployStatus'));

type ThemeColors = ReturnType<typeof useTheme>['colors'];

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
}

interface IssuesPageProps {
  onBack: () => void;
  onOpenPR?: (repo: string, prNumber: number) => void;
}

const STORAGE_KEY = 'cortex-ide:registered-repos';
const DEFAULT_REPOS = ['', 'hurttlocker/cortex'];

function sectionHeaderStyle(colors: ThemeColors) {
  return {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: colors.textSecondary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: 8,
    padding: '0 4px',
  };
}

function loadRegisteredRepos(): string[] {
  if (typeof window === 'undefined') return DEFAULT_REPOS;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return DEFAULT_REPOS;
}

function saveRegisteredRepos(repos: string[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(repos));
  } catch {}
}

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
    '': 'Cortex IDE',
    'hurttlocker/cortex': 'Cortex',
    'LavonTMCQ/spear-production': 'Spear',
    'LavonTMCQ/mybeautifulwife': 'Antiflammi',
  };
  return map[repo] ?? repo.split('/').pop() ?? repo;
}

function checksRollup(checks: { status: string; conclusion: string }[]): { color: string; label: string } {
  if (!checks || checks.length === 0) return { color: '#A09890', label: 'No CI' };
  const failed = checks.some((check) => check.conclusion === 'FAILURE');
  const pending = checks.some((check) => check.status !== 'COMPLETED');
  if (failed) return { color: '#ff453a', label: 'CI Failed' };
  if (pending) return { color: '#ff9f0a', label: 'CI Running' };
  return { color: '#30d158', label: 'CI Passed' };
}

const IssueCard = memo(function IssueCard({ issue, repo }: { issue: Issue; repo: string }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setExpanded(!expanded)}
      onTouchEnd={(event) => {
        setExpanded(!expanded);
        event.preventDefault();
      }}
      style={{
        padding: '14px',
        borderRadius: 14,
        background: colors.cardBg,
        border: `1px solid ${colors.cardBorder}`,
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#30d158"
          strokeWidth="2"
          strokeLinecap="round"
          style={{ flexShrink: 0, marginTop: 2 }}
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, lineHeight: 1.4 }}>{issue.title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: colors.textSecondary, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
              #{issue.number}
            </span>
            <span
              style={{
                fontSize: 10,
                color: colors.blueAccent,
                padding: '3px 8px',
                borderRadius: 999,
                background: colors.blueGlass,
                border: `1px solid ${colors.blueGlassBorder}`,
                fontWeight: 600,
              }}
            >
              {repoShort(repo)}
            </span>
            {issue.createdAt ? <span style={{ fontSize: 10, color: colors.textSecondary }}>{timeAgo(issue.createdAt)}</span> : null}
          </div>
        </div>
      </div>
      {issue.labels.length > 0 ? (
        <div style={{ display: 'flex', gap: 4, marginTop: 10, flexWrap: 'wrap' }}>
          {issue.labels.map((label) => (
            <span
              key={label.name}
              style={{
                fontSize: 10,
                fontWeight: 600,
                padding: '3px 8px',
                borderRadius: 999,
                background: `#${label.color}18`,
                color: `#${label.color}`,
                border: `1px solid #${label.color}30`,
              }}
            >
              {label.name}
            </span>
          ))}
        </div>
      ) : null}
      {expanded && issue.body ? (
        <p
          style={{
            marginTop: 10,
            fontSize: 12,
            lineHeight: 1.5,
            color: colors.textSecondary,
            whiteSpace: 'pre-wrap',
            display: '-webkit-box',
            WebkitLineClamp: 8,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {issue.body.slice(0, 600)}
        </p>
      ) : null}
    </div>
  );
});

const PRCard = memo(function PRCard({
  pr,
  repo,
  onOpen,
}: {
  pr: PR;
  repo: string;
  onOpen: () => void;
}) {
  const { colors } = useTheme();
  const ci = checksRollup(pr.statusCheckRollup);

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      onTouchEnd={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }}
      style={{
        width: '100%',
        minHeight: 44,
        padding: '14px',
        borderRadius: 14,
        background: colors.cardBg,
        border: `1px solid ${colors.cardBorder}`,
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
        textAlign: 'left',
        display: 'block',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke={colors.blueAccent}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0, marginTop: 2 }}
        >
          <circle cx="18" cy="18" r="3" />
          <circle cx="6" cy="6" r="3" />
          <path d="M13 6h3a2 2 0 0 1 2 2v7" />
          <line x1="6" y1="9" x2="6" y2="21" />
        </svg>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, lineHeight: 1.4 }}>{pr.title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: colors.textSecondary, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
              #{pr.number}
            </span>
            <span
              style={{
                fontSize: 10,
                color: colors.blueAccent,
                padding: '3px 8px',
                borderRadius: 999,
                background: colors.blueGlass,
                border: `1px solid ${colors.blueGlassBorder}`,
                fontWeight: 600,
              }}
            >
              {repoShort(repo)}
            </span>
            <span style={{ fontSize: 10, color: colors.textSecondary }}>{pr.headRefName}</span>
          </div>
        </div>
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            padding: '4px 8px',
            borderRadius: 999,
            background: `${ci.color}18`,
            color: ci.color,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {ci.label}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, marginLeft: 22, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: colors.textSecondary }}>{pr.changedFiles} files</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#30d158', fontFamily: '"SF Mono", monospace' }}>
          +{pr.additions}
        </span>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#ff453a', fontFamily: '"SF Mono", monospace' }}>
          -{pr.deletions}
        </span>
        {pr.reviewDecision ? (
          <span
            style={{
              fontSize: 9,
              fontWeight: 600,
              marginLeft: 'auto',
              color:
                pr.reviewDecision === 'APPROVED'
                  ? '#30d158'
                  : pr.reviewDecision === 'CHANGES_REQUESTED'
                    ? '#ff453a'
                    : '#ff9f0a',
            }}
          >
            {pr.reviewDecision === 'APPROVED'
              ? 'Approved'
              : pr.reviewDecision === 'CHANGES_REQUESTED'
                ? 'Changes requested'
                : 'Review needed'}
          </span>
        ) : null}
      </div>
    </button>
  );
});

function RepoSwitcher({
  repos,
  selected,
  onSelect,
  onAddRepo,
}: {
  repos: string[];
  selected: string;
  onSelect: (repo: string) => void;
  onAddRepo: (repo: string) => void;
}) {
  const { colors } = useTheme();
  const [showAdd, setShowAdd] = useState(false);
  const [input, setInput] = useState('');

  const handleAdd = () => {
    const trimmed = input.trim();
    if (trimmed && /^[\w.-]+\/[\w.-]+$/.test(trimmed) && !repos.includes(trimmed)) {
      onAddRepo(trimmed);
      setInput('');
      setShowAdd(false);
    }
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <span style={sectionHeaderStyle(colors)}>Repositories</span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => onSelect('all')}
          onTouchEnd={(event) => {
            onSelect('all');
            event.preventDefault();
          }}
          style={{
            minHeight: 44,
            padding: '0 14px',
            borderRadius: 12,
            border: selected === 'all' ? `1px solid ${colors.blueGlassBorder}` : `1px solid ${colors.cardBorder}`,
            background: selected === 'all' ? colors.blueGlass : colors.cardBg,
            color: selected === 'all' ? colors.text : colors.textSecondary,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'manipulation',
          }}
        >
          All
        </button>
        {repos.map((repo) => (
          <button
            key={repo}
            type="button"
            onClick={() => onSelect(repo)}
            onTouchEnd={(event) => {
              onSelect(repo);
              event.preventDefault();
            }}
            style={{
              minHeight: 44,
              maxWidth: 180,
              padding: '0 14px',
              borderRadius: 12,
              border: selected === repo ? `1px solid ${colors.blueGlassBorder}` : `1px solid ${colors.cardBorder}`,
              background: selected === repo ? colors.blueGlass : colors.cardBg,
              color: selected === repo ? colors.text : colors.textSecondary,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
              touchAction: 'manipulation',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {repoShort(repo)}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowAdd(!showAdd)}
          onTouchEnd={(event) => {
            setShowAdd(!showAdd);
            event.preventDefault();
          }}
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            border: `1px solid ${colors.cardBorder}`,
            background: colors.cardBg,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'manipulation',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={colors.blueAccent} strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {showAdd ? (
        <div
          style={{
            display: 'flex',
            gap: 6,
            marginTop: 8,
            padding: 8,
            borderRadius: 14,
            background: colors.cardBg,
            border: `1px solid ${colors.cardBorder}`,
          }}
        >
          <input
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleAdd();
            }}
            placeholder="owner/repo"
            style={{
              flex: 1,
              minHeight: 44,
              padding: '0 12px',
              borderRadius: 12,
              border: `1px solid ${colors.cardBorder}`,
              background: 'rgba(255,255,255,0.04)',
              fontSize: 13,
              color: colors.text,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              outline: 'none',
              WebkitAppearance: 'none',
            }}
          />
          <button
            type="button"
            onClick={handleAdd}
            onTouchEnd={(event) => {
              handleAdd();
              event.preventDefault();
            }}
            style={{
              minHeight: 44,
              padding: '0 16px',
              borderRadius: 12,
              border: 'none',
              background: colors.blueAccent,
              color: colors.text,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
              touchAction: 'manipulation',
            }}
          >
            Add
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  const { colors } = useTheme();
  return <span style={sectionHeaderStyle(colors)}>{label}</span>;
}

export default function IssuesPage({ onBack, onOpenPR }: IssuesPageProps) {
  const { colors } = useTheme();
  const [repos, setRepos] = useState<string[]>(DEFAULT_REPOS);
  const [issues, setIssues] = useState<{ issue: Issue; repo: string }[]>([]);
  const [prs, setPRs] = useState<{ pr: PR; repo: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'all' | 'issues' | 'prs'>('all');
  const [selectedRepo, setSelectedRepo] = useState('all');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setRepos(loadRegisteredRepos());
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  const fetchAll = useCallback(async (repoList: string[]) => {
    setLoading(true);
    const issueResults: { issue: Issue; repo: string }[] = [];
    const prResults: { pr: PR; repo: string }[] = [];
    await Promise.all(
      repoList.map(async (repo) => {
        try {
          const issueResponse = await fetch(`/api/panel/issues?repo=${encodeURIComponent(repo)}`);
          const issueData = await issueResponse.json();
          for (const issue of issueData.issues ?? []) issueResults.push({ issue, repo });
        } catch {}
        try {
          const prResponse = await fetch(`/api/panel/prs?repo=${encodeURIComponent(repo)}`);
          const prData = await prResponse.json();
          for (const pr of prData.prs ?? []) prResults.push({ pr, repo });
        } catch {}
      })
    );
    issueResults.sort((a, b) => b.issue.number - a.issue.number);
    prResults.sort((a, b) => b.pr.number - a.pr.number);
    setIssues(issueResults);
    setPRs(prResults);
    setLoading(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchAll(repos);
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [fetchAll, repos]);

  const addRepo = useCallback(
    (repo: string) => {
      const updated = [...repos, repo];
      setRepos(updated);
      saveRegisteredRepos(updated);
    },
    [repos]
  );

  const filteredIssues = selectedRepo === 'all' ? issues : issues.filter((entry) => entry.repo === selectedRepo);
  const filteredPRs = selectedRepo === 'all' ? prs : prs.filter((entry) => entry.repo === selectedRepo);

  const tabs: { key: 'all' | 'prs' | 'issues'; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: filteredIssues.length + filteredPRs.length },
    { key: 'prs', label: 'PRs', count: filteredPRs.length },
    { key: 'issues', label: 'Issues', count: filteredIssues.length },
  ];

  return (
    <div style={{ padding: '0 12px 24px', width: '100%', boxSizing: 'border-box', background: colors.bg, minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.03em', color: colors.text, margin: 0 }}>
            Issues & PRs
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: colors.textSecondary, fontWeight: 500 }}>
            {loading ? 'Loading...' : `${filteredIssues.length} issues · ${filteredPRs.length} PRs`}
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          style={{
            minHeight: 44,
            padding: '0 16px',
            borderRadius: 12,
            border: 'none',
            background: colors.blueAccent,
            color: colors.text,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          Done
        </button>
      </div>

      <RepoSwitcher repos={repos} selected={selectedRepo} onSelect={setSelectedRepo} onAddRepo={addRepo} />

      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: 4,
          borderRadius: 14,
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          marginBottom: 16,
        }}
      >
        {tabs.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              onTouchEnd={(event) => {
                setActiveTab(tab.key);
                event.preventDefault();
              }}
              style={{
                flex: 1,
                minHeight: 44,
                borderRadius: 12,
                border: active ? `1px solid ${colors.blueGlassBorder}` : '1px solid transparent',
                background: active ? colors.blueGlass : 'transparent',
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600, color: active ? colors.text : colors.textSecondary }}>
                {tab.label}
              </span>
              <span
                style={{
                  minWidth: 18,
                  height: 18,
                  borderRadius: 999,
                  padding: '0 5px',
                  background: active ? colors.blueAccent : colors.surfaceBorder,
                  color: active ? colors.text : colors.textSecondary,
                  fontSize: 10,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {loading ? (
          <div
            style={{
              padding: '32px 20px',
              textAlign: 'center',
              color: colors.textSecondary,
              fontSize: 14,
              borderRadius: 14,
              background: colors.cardBg,
              border: `1px solid ${colors.cardBorder}`,
            }}
          >
            Loading...
          </div>
        ) : (
          <>
            {(activeTab === 'all' || activeTab === 'prs') && filteredPRs.length > 0 ? (
              <>
                {activeTab === 'all' ? <SectionHeader label="Pull Requests" /> : null}
                {filteredPRs.map(({ pr, repo }) => (
                  <PRCard key={`pr-${repo}-${pr.number}`} pr={pr} repo={repo} onOpen={() => onOpenPR?.(repo, pr.number)} />
                ))}
              </>
            ) : null}
            {(activeTab === 'all' || activeTab === 'issues') && filteredIssues.length > 0 ? (
              <>
                {activeTab === 'all' ? <SectionHeader label="Issues" /> : null}
                {filteredIssues.map(({ issue, repo }) => (
                  <IssueCard key={`issue-${repo}-${issue.number}`} issue={issue} repo={repo} />
                ))}
              </>
            ) : null}
            {activeTab === 'prs' && filteredPRs.length === 0 ? (
              <div
                style={{
                  padding: '32px 20px',
                  textAlign: 'center',
                  color: colors.textSecondary,
                  fontSize: 14,
                  borderRadius: 14,
                  background: colors.cardBg,
                  border: `1px solid ${colors.cardBorder}`,
                }}
              >
                No open PRs
              </div>
            ) : null}
            {activeTab === 'issues' && filteredIssues.length === 0 ? (
              <div
                style={{
                  padding: '32px 20px',
                  textAlign: 'center',
                  color: colors.textSecondary,
                  fontSize: 14,
                  borderRadius: 14,
                  background: colors.cardBg,
                  border: `1px solid ${colors.cardBorder}`,
                }}
              >
                No open issues
              </div>
            ) : null}
          </>
        )}
      </div>

      <div style={{ marginTop: 24 }}>
        <SectionHeader label="Deployments" />
        <Suspense
          fallback={
            <div
              style={{
                padding: '20px',
                textAlign: 'center',
                color: colors.textSecondary,
                fontSize: 13,
                borderRadius: 14,
                background: colors.cardBg,
                border: `1px solid ${colors.cardBorder}`,
              }}
            >
              Loading...
            </div>
          }
        >
          <DeployStatus repos={repos} />
        </Suspense>
      </div>
    </div>
  );
}
