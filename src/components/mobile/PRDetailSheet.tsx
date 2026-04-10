'use client';

import { memo, useCallback, useEffect, useState } from 'react';
import { useTheme } from './ThemeContext';

type ThemeColors = ReturnType<typeof useTheme>['colors'];

interface PRCheck {
  name: string;
  status: string;
  conclusion: string;
}

interface PRFile {
  path: string;
  additions: number;
  deletions: number;
}

interface PRDetail {
  number: number;
  title: string;
  body: string;
  author: string;
  branch: string;
  baseBranch: string;
  state: string;
  mergeable: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  checksStatus: string;
  reviewDecision: string;
  files: PRFile[];
  checks: PRCheck[];
  url: string;
}

interface PRDetailSheetProps {
  repoPath: string;
  prNumber: number;
  visible: boolean;
  onClose: () => void;
}

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

function normalizeRepoPath(repoPath: string): string {
  // Drop leading `/` and collapse any `/Users/<me>/<workspace>/repos/<repo>`
  // into just `<repo>` for display. Previously this hardcoded `hurttlocker/`
  // as the owner prefix which leaked a personal GitHub handle to every UI.
  const trimmed = repoPath.replace(/^\//, '');
  const reposMatch = trimmed.match(/^Users\/[^/]+\/[^/]+\/repos\/(.+)$/);
  if (reposMatch) return reposMatch[1];
  return trimmed;
}

function checksStatusColor(status: string): string {
  switch (status) {
    case 'success':
      return '#30d158';
    case 'failure':
      return '#ff453a';
    case 'pending':
      return '#ff9f0a';
    default:
      return '#A09890';
  }
}

function checksStatusLabel(status: string): string {
  switch (status) {
    case 'success':
      return 'All checks passed';
    case 'failure':
      return 'Checks failed';
    case 'pending':
      return 'Checks running';
    default:
      return 'No checks';
  }
}

function reviewLabel(decision: string): string {
  switch (decision) {
    case 'APPROVED':
      return 'Approved';
    case 'CHANGES_REQUESTED':
      return 'Changes requested';
    case 'REVIEW_REQUIRED':
      return 'Review required';
    default:
      return 'No reviews';
  }
}

function reviewColor(decision: string): string {
  switch (decision) {
    case 'APPROVED':
      return '#30d158';
    case 'CHANGES_REQUESTED':
      return '#ff453a';
    case 'REVIEW_REQUIRED':
      return '#ff9f0a';
    default:
      return '#A09890';
  }
}

function fileIcon(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx'].includes(ext)) return '#64d2ff';
  if (['js', 'jsx'].includes(ext)) return '#ffd60a';
  if (['css', 'scss'].includes(ext)) return '#bf5af2';
  if (['json', 'yaml', 'yml'].includes(ext)) return '#30d158';
  if (['md', 'mdx'].includes(ext)) return '#A09890';
  if (['go'].includes(ext)) return '#0a84ff';
  return '#706860';
}

const CheckRow = memo(function CheckRow({ check }: { check: PRCheck }) {
  const { colors } = useTheme();
  const passed = check.conclusion === 'SUCCESS' || check.conclusion === 'success';
  const failed = check.conclusion === 'FAILURE' || check.conclusion === 'failure';
  const statusColor = passed ? '#30d158' : failed ? '#ff453a' : '#ff9f0a';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '12px 14px',
        borderRadius: 14,
        background: colors.cardBg,
        border: `1px solid ${colors.cardBorder}`,
      }}
    >
      {passed ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#30d158" strokeWidth="2.5" strokeLinecap="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : failed ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff453a" strokeWidth="2.5" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff9f0a" strokeWidth="2.5" strokeLinecap="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 3" />
        </svg>
      )}
      <span
        style={{
          flex: 1,
          fontSize: 13,
          color: colors.text,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {check.name}
      </span>
      <span style={{ fontSize: 10, fontWeight: 700, color: statusColor }}>
        {passed ? 'Passed' : failed ? 'Failed' : 'Running'}
      </span>
    </div>
  );
});

const FileRow = memo(function FileRow({ file }: { file: PRFile }) {
  const { colors } = useTheme();
  const filename = file.path.split('/').pop() ?? file.path;
  const dir = file.path.split('/').slice(0, -1).join('/');

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '12px 14px',
        borderRadius: 14,
        background: colors.cardBg,
        border: `1px solid ${colors.cardBorder}`,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: fileIcon(file.path),
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: colors.text, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
          {filename}
        </span>
        {dir ? (
          <span
            style={{
              fontSize: 10,
              color: colors.textSecondary,
              marginLeft: 6,
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}
          >
            {dir}
          </span>
        ) : null}
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {file.additions > 0 ? (
          <span style={{ fontSize: 11, fontWeight: 600, color: '#30d158', fontFamily: '"SF Mono", monospace' }}>
            +{file.additions}
          </span>
        ) : null}
        {file.deletions > 0 ? (
          <span style={{ fontSize: 11, fontWeight: 600, color: '#ff453a', fontFamily: '"SF Mono", monospace' }}>
            -{file.deletions}
          </span>
        ) : null}
      </div>
    </div>
  );
});

function StatusCard({ label, value, color }: { label: string; value: string; color: string }) {
  const { colors } = useTheme();

  return (
    <div
      style={{
        flex: 1,
        padding: '12px 14px',
        borderRadius: 14,
        background: colors.cardBg,
        border: `1px solid ${colors.cardBorder}`,
      }}
    >
      <div style={sectionHeaderStyle(colors)}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

export default function PRDetailSheet({ repoPath, prNumber, visible, onClose }: PRDetailSheetProps) {
  const { colors } = useTheme();
  const [pr, setPR] = useState<PRDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'checks' | 'files'>('overview');
  const [reviewing, setReviewing] = useState(false);
  const [reviewResult, setReviewResult] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setPR(null);
      setActiveTab('overview');
      setReviewResult(null);
      const repo = normalizeRepoPath(repoPath);
      fetch(`/api/panel/pr?repo=${encodeURIComponent(repo)}&number=${prNumber}`)
        .then((response) => response.json())
        .then((data) => {
          if (cancelled) return;
          if (data.error) {
            setLoading(false);
            return;
          }
          setPR(data);
          setLoading(false);
        })
        .catch(() => {
          if (!cancelled) {
            setLoading(false);
          }
        });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [visible, repoPath, prNumber]);

  const handleReview = useCallback(
    async (action: 'approve' | 'request_changes') => {
      if (!pr) return;
      setReviewing(true);
      try {
        const repo = normalizeRepoPath(repoPath);
        const response = await fetch('/api/panel/pr/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo, number: pr.number, action }),
        });
        const data = await response.json();
        setReviewResult(data.success ? (action === 'approve' ? 'Approved' : 'Changes requested') : 'Failed');
      } catch {
        setReviewResult('Failed');
      }
      setReviewing(false);
    },
    [pr, repoPath]
  );

  if (!visible) return null;

  const tabs: { key: 'overview' | 'checks' | 'files'; label: string; count?: number }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'checks', label: 'Checks', count: pr?.checks?.length ?? 0 },
    { key: 'files', label: 'Files', count: pr?.changedFiles ?? 0 },
  ];

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9998, display: 'flex', flexDirection: 'column' }}>
      <div
        onClick={onClose}
        onTouchEnd={(event) => {
          onClose();
          event.preventDefault();
        }}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.78)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}
      />

      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          maxHeight: '88vh',
          borderRadius: '24px 24px 0 0',
          background: colors.bg,
          borderTop: `1px solid ${colors.cardBorder}`,
          boxShadow: '0 -16px 40px rgba(0,0,0,0.45)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 6px' }}>
          <div style={{ width: 36, height: 4, borderRadius: 999, background: colors.textTertiary }} />
        </div>

        {loading ? (
          <div style={{ padding: 60, textAlign: 'center', color: colors.textSecondary, fontSize: 14 }}>
            Loading PR #{prNumber}...
          </div>
        ) : !pr ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#ff453a', fontSize: 14 }}>Failed to load PR</div>
        ) : (
          <>
            <div style={{ padding: '8px 16px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={colors.blueAccent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="18" cy="18" r="3" />
                  <circle cx="6" cy="6" r="3" />
                  <path d="M13 6h3a2 2 0 0 1 2 2v7" />
                  <line x1="6" y1="9" x2="6" y2="21" />
                </svg>
                <span style={{ fontSize: 11, fontWeight: 700, color: colors.blueAccent, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                  #{pr.number}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: checksStatusColor(pr.checksStatus),
                    fontWeight: 700,
                    padding: '4px 8px',
                    borderRadius: 999,
                    background: `${checksStatusColor(pr.checksStatus)}18`,
                    marginLeft: 'auto',
                  }}
                >
                  {checksStatusLabel(pr.checksStatus)}
                </span>
              </div>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: colors.text, letterSpacing: '-0.02em', margin: 0, lineHeight: 1.3 }}>
                {pr.title}
              </h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: 11,
                    color: colors.blueAccent,
                    fontWeight: 600,
                    padding: '4px 8px',
                    borderRadius: 999,
                    background: colors.blueGlass,
                    border: `1px solid ${colors.blueGlassBorder}`,
                  }}
                >
                  {pr.branch} → {pr.baseBranch}
                </span>
                <span style={{ fontSize: 11, color: colors.textSecondary }}>by {pr.author}</span>
                <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#30d158', fontFamily: '"SF Mono", monospace' }}>
                    +{pr.additions}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#ff453a', fontFamily: '"SF Mono", monospace' }}>
                    -{pr.deletions}
                  </span>
                </div>
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                gap: 4,
                padding: '0 16px 4px',
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
                      border: active ? `1px solid ${colors.blueGlassBorder}` : `1px solid ${colors.cardBorder}`,
                      background: active ? colors.blueGlass : colors.cardBg,
                      color: active ? colors.text : colors.textSecondary,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      WebkitTapHighlightColor: 'transparent',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 4,
                    }}
                  >
                    {tab.label}
                    {tab.count !== undefined ? <span style={{ fontSize: 10, fontWeight: 700 }}>{tab.count}</span> : null}
                  </button>
                );
              })}
            </div>

            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                WebkitOverflowScrolling: 'touch',
                padding: '12px 16px calc(24px + env(safe-area-inset-bottom, 0px))',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              {activeTab === 'overview' ? (
                <>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <StatusCard
                      label="CI Status"
                      value={checksStatusLabel(pr.checksStatus)}
                      color={checksStatusColor(pr.checksStatus)}
                    />
                    <StatusCard
                      label="Review"
                      value={reviewLabel(pr.reviewDecision)}
                      color={reviewColor(pr.reviewDecision)}
                    />
                  </div>

                  {pr.body ? (
                    <div
                      style={{
                        padding: '14px',
                        borderRadius: 14,
                        background: colors.cardBg,
                        border: `1px solid ${colors.cardBorder}`,
                      }}
                    >
                      <span style={sectionHeaderStyle(colors)}>Description</span>
                      <p
                        style={{
                          margin: 0,
                          fontSize: 13,
                          lineHeight: 1.6,
                          color: colors.textSecondary,
                          whiteSpace: 'pre-wrap',
                          display: '-webkit-box',
                          WebkitLineClamp: 10,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {pr.body}
                      </p>
                    </div>
                  ) : null}

                  {reviewResult ? (
                    <div
                      style={{
                        padding: 14,
                        borderRadius: 14,
                        textAlign: 'center',
                        background: colors.cardBg,
                        border: `1px solid ${reviewResult === 'Failed' ? '#ff453a40' : colors.cardBorder}`,
                        color: reviewResult === 'Failed' ? '#ff453a' : '#30d158',
                        fontSize: 14,
                        fontWeight: 700,
                      }}
                    >
                      {reviewResult}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => handleReview('approve')}
                        onTouchEnd={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          handleReview('approve');
                        }}
                        disabled={reviewing}
                        style={{
                          flex: 1,
                          minHeight: 44,
                          borderRadius: 12,
                          border: 'none',
                          background: colors.blueAccent,
                          color: colors.text,
                          fontSize: 14,
                          fontWeight: 700,
                          cursor: 'pointer',
                          opacity: reviewing ? 0.6 : 1,
                          WebkitTapHighlightColor: 'transparent',
                          touchAction: 'manipulation',
                        }}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReview('request_changes')}
                        onTouchEnd={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          handleReview('request_changes');
                        }}
                        disabled={reviewing}
                        style={{
                          flex: 1,
                          minHeight: 44,
                          borderRadius: 12,
                          border: '1px solid rgba(255,69,58,0.22)',
                          background: 'rgba(255,69,58,0.12)',
                          color: '#ff453a',
                          fontSize: 14,
                          fontWeight: 700,
                          cursor: 'pointer',
                          opacity: reviewing ? 0.6 : 1,
                          WebkitTapHighlightColor: 'transparent',
                          touchAction: 'manipulation',
                        }}
                      >
                        Request Changes
                      </button>
                    </div>
                  )}
                </>
              ) : activeTab === 'checks' ? (
                <>
                  {pr.checks.length === 0 ? (
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
                      No CI checks configured
                    </div>
                  ) : (
                    pr.checks.map((check, index) => <CheckRow key={`${check.name}-${index}`} check={check} />)
                  )}
                </>
              ) : (
                pr.files.map((file, index) => <FileRow key={`${file.path}-${index}`} file={file} />)
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
