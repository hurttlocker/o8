'use client';

import { useState, useEffect, useCallback, memo } from 'react';

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

function checksStatusColor(status: string): string {
  switch (status) {
    case 'success': return '#34c759';
    case 'failure': return '#ff3b30';
    case 'pending': return '#ff9f0a';
    default: return '#8e8e93';
  }
}

function checksStatusLabel(status: string): string {
  switch (status) {
    case 'success': return 'All checks passed';
    case 'failure': return 'Checks failed';
    case 'pending': return 'Checks running';
    default: return 'No checks';
  }
}

function reviewLabel(decision: string): string {
  switch (decision) {
    case 'APPROVED': return 'Approved';
    case 'CHANGES_REQUESTED': return 'Changes requested';
    case 'REVIEW_REQUIRED': return 'Review required';
    default: return 'No reviews';
  }
}

function reviewColor(decision: string): string {
  switch (decision) {
    case 'APPROVED': return '#34c759';
    case 'CHANGES_REQUESTED': return '#ff3b30';
    case 'REVIEW_REQUIRED': return '#ff9f0a';
    default: return '#8e8e93';
  }
}

function fileIcon(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx'].includes(ext)) return '#007aff';
  if (['js', 'jsx'].includes(ext)) return '#f5a623';
  if (['css', 'scss'].includes(ext)) return '#af52de';
  if (['json', 'yaml', 'yml'].includes(ext)) return '#34c759';
  if (['md', 'mdx'].includes(ext)) return '#8e8e93';
  if (['go'].includes(ext)) return '#00add8';
  return '#636366';
}

const CheckRow = memo(function CheckRow({ check }: { check: PRCheck }) {
  const passed = check.conclusion === 'SUCCESS' || check.conclusion === 'success';
  const failed = check.conclusion === 'FAILURE' || check.conclusion === 'failure';
  const pending = check.status !== 'COMPLETED' && check.status !== 'completed';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 0',
      borderBottom: '1px solid rgba(0,0,0,0.04)',
    }}>
      {passed ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34c759" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
      ) : failed ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff3b30" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      ) : (
        <div style={{
          width: 14, height: 14,
          border: '2px solid #ff9f0a', borderTop: '2px solid transparent',
          borderRadius: '50%', animation: 'spin 1s linear infinite',
        }} />
      )}
      <span style={{
        flex: 1, fontSize: 13, color: '#1c1c1e',
        fontFamily: '-apple-system, system-ui, sans-serif',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {check.name}
      </span>
      <span style={{
        fontSize: 10, fontWeight: 600,
        color: passed ? '#34c759' : failed ? '#ff3b30' : '#ff9f0a',
      }}>
        {passed ? 'Passed' : failed ? 'Failed' : 'Running'}
      </span>
    </div>
  );
});

const FileRow = memo(function FileRow({ file }: { file: PRFile }) {
  const filename = file.path.split('/').pop() ?? file.path;
  const dir = file.path.split('/').slice(0, -1).join('/');

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 0',
      borderBottom: '1px solid rgba(0,0,0,0.03)',
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: fileIcon(file.path),
        flexShrink: 0,
      }} />
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <span style={{
          fontSize: 13, fontWeight: 600, color: '#0a0a0a',
          fontFamily: '"SF Mono", ui-monospace, monospace',
        }}>
          {filename}
        </span>
        {dir ? (
          <span style={{
            fontSize: 10, color: '#8e8e93', marginLeft: 4,
            fontFamily: '"SF Mono", ui-monospace, monospace',
          }}>
            {dir}
          </span>
        ) : null}
      </div>
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        {file.additions > 0 ? (
          <span style={{ fontSize: 11, fontWeight: 600, color: '#34c759', fontFamily: '"SF Mono", monospace' }}>
            +{file.additions}
          </span>
        ) : null}
        {file.deletions > 0 ? (
          <span style={{ fontSize: 11, fontWeight: 600, color: '#ff3b30', fontFamily: '"SF Mono", monospace' }}>
            -{file.deletions}
          </span>
        ) : null}
      </div>
    </div>
  );
});

export default function PRDetailSheet({ repoPath, prNumber, visible, onClose }: PRDetailSheetProps) {
  const [pr, setPR] = useState<PRDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'checks' | 'files'>('overview');
  const [reviewing, setReviewing] = useState(false);
  const [reviewResult, setReviewResult] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setPR(null);
    setActiveTab('overview');
    setReviewResult(null);
    const repo = repoPath.replace(/^\//, '').replace(/^Users\/.*?\/clawd\/repos\//, 'hurttlocker/');
    fetch(`/api/panel/pr?repo=${encodeURIComponent(repo)}&number=${prNumber}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) { setLoading(false); return; }
        setPR(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [visible, repoPath, prNumber]);

  const handleReview = useCallback(async (action: 'approve' | 'request_changes') => {
    if (!pr) return;
    setReviewing(true);
    try {
      const repo = repoPath.replace(/^\//, '').replace(/^Users\/.*?\/clawd\/repos\//, 'hurttlocker/');
      const res = await fetch('/api/panel/pr/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, number: pr.number, action }),
      });
      const data = await res.json();
      setReviewResult(data.success ? (action === 'approve' ? 'Approved' : 'Changes requested') : 'Failed');
    } catch {
      setReviewResult('Failed');
    }
    setReviewing(false);
  }, [pr, repoPath]);

  if (!visible) return null;

  const tabs: { key: typeof activeTab; label: string; count?: number }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'checks', label: 'Checks', count: pr?.checks?.length ?? 0 },
    { key: 'files', label: 'Files', count: pr?.changedFiles ?? 0 },
  ];

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9998,
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Backdrop */}
      <div
        onClick={onClose}
        onTouchEnd={(e) => { onClose(); e.preventDefault(); }}
        style={{
          position: 'absolute', inset: 0,
          background: 'rgba(0,0,0,0.3)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
        }}
      />

      {/* Sheet */}
      <div style={{
        position: 'absolute',
        bottom: 0, left: 0, right: 0,
        maxHeight: '85vh',
        borderRadius: '20px 20px 0 0',
        background: 'rgba(255,255,255,0.97)',
        backdropFilter: 'blur(40px) saturate(1.8)',
        WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
        boxShadow: '0 -10px 40px rgba(0,0,0,0.12)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        animation: 'slideUp 250ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}>
        {/* Handle */}
        <div style={{
          display: 'flex', justifyContent: 'center', padding: '8px 0 4px',
        }}>
          <div style={{
            width: 36, height: 4, borderRadius: 2,
            background: 'rgba(0,0,0,0.15)',
          }} />
        </div>

        {loading ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#8e8e93', fontSize: 14 }}>
            Loading PR #{prNumber}...
          </div>
        ) : !pr ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#ff3b30', fontSize: 14 }}>
            Failed to load PR
          </div>
        ) : (
          <>
            {/* Header */}
            <div style={{ padding: '8px 16px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                  stroke="#007aff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" />
                  <path d="M13 6h3a2 2 0 0 1 2 2v7" /><line x1="6" y1="9" x2="6" y2="21" />
                </svg>
                <span style={{
                  fontSize: 11, fontWeight: 600, color: '#007aff',
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                }}>
                  #{pr.number}
                </span>
                <span style={{
                  fontSize: 10, color: checksStatusColor(pr.checksStatus), fontWeight: 700,
                  padding: '2px 8px', borderRadius: 8,
                  background: `${checksStatusColor(pr.checksStatus)}15`,
                  marginLeft: 'auto',
                }}>
                  {pr.checksStatus === 'success' ? '✓ CI' : pr.checksStatus === 'failure' ? '✗ CI' : '● CI'}
                </span>
              </div>
              <h2 style={{
                fontSize: 18, fontWeight: 700, color: '#0a0a0a',
                fontFamily: '-apple-system, system-ui, sans-serif',
                letterSpacing: '-0.02em',
                margin: 0, lineHeight: 1.3,
              }}>
                {pr.title}
              </h2>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, marginTop: 8,
                flexWrap: 'wrap',
              }}>
                <span style={{
                  fontSize: 11, color: '#636366', fontWeight: 500,
                  padding: '2px 8px', borderRadius: 6,
                  background: 'rgba(0,0,0,0.04)',
                }}>
                  {pr.branch} → {pr.baseBranch}
                </span>
                <span style={{ fontSize: 11, color: '#8e8e93' }}>by {pr.author}</span>
                <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#34c759', fontFamily: '"SF Mono", monospace' }}>
                    +{pr.additions}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#ff3b30', fontFamily: '"SF Mono", monospace' }}>
                    -{pr.deletions}
                  </span>
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div style={{
              display: 'flex', padding: '0 16px',
              gap: 1, marginBottom: 0,
            }}>
              {tabs.map(tab => (
                <button key={tab.key} type="button"
                  onClick={() => setActiveTab(tab.key)}
                  onTouchEnd={(e) => { setActiveTab(tab.key); e.preventDefault(); }}
                  style={{
                    flex: 1, padding: '10px 0',
                    border: 'none', background: 'transparent',
                    borderBottom: activeTab === tab.key ? '2px solid #007aff' : '2px solid transparent',
                    color: activeTab === tab.key ? '#007aff' : '#8e8e93',
                    fontSize: 13, fontWeight: 600,
                    cursor: 'pointer',
                    WebkitTapHighlightColor: 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                    transition: 'all 200ms ease',
                  }}
                >
                  {tab.label}
                  {tab.count !== undefined ? (
                    <span style={{
                      fontSize: 10, fontWeight: 700,
                      color: activeTab === tab.key ? '#007aff' : '#8e8e93',
                    }}>
                      {tab.count}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>

            {/* Content */}
            <div style={{
              flex: 1, overflowY: 'auto',
              WebkitOverflowScrolling: 'touch',
              padding: '12px 16px 24px',
            }}>
              {activeTab === 'overview' ? (
                <div>
                  {/* Status cards */}
                  <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
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

                  {/* Body */}
                  {pr.body ? (
                    <div style={{
                      padding: '12px 14px', borderRadius: 12,
                      background: 'rgba(0,0,0,0.02)',
                      marginBottom: 16,
                    }}>
                      <p style={{
                        margin: 0, fontSize: 13, lineHeight: 1.5,
                        color: '#3c3c43', whiteSpace: 'pre-wrap',
                        display: '-webkit-box', WebkitLineClamp: 10,
                        WebkitBoxOrient: 'vertical', overflow: 'hidden',
                      }}>
                        {pr.body}
                      </p>
                    </div>
                  ) : null}

                  {/* Review actions */}
                  {reviewResult ? (
                    <div style={{
                      padding: 14, borderRadius: 12, textAlign: 'center',
                      background: reviewResult === 'Failed' ? 'rgba(255,59,48,0.06)' : 'rgba(52,199,89,0.06)',
                      color: reviewResult === 'Failed' ? '#ff3b30' : '#34c759',
                      fontSize: 14, fontWeight: 700,
                    }}>
                      {reviewResult}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button"
                        onClick={() => handleReview('approve')}
                        onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); handleReview('approve'); }}
                        disabled={reviewing}
                        style={{
                          flex: 1, padding: '12px',
                          borderRadius: 12, border: 'none',
                          background: '#34c759', color: '#fff',
                          fontSize: 14, fontWeight: 700,
                          cursor: 'pointer',
                          opacity: reviewing ? 0.6 : 1,
                          WebkitTapHighlightColor: 'transparent',
                          touchAction: 'manipulation',
                        }}
                      >
                        Approve
                      </button>
                      <button type="button"
                        onClick={() => handleReview('request_changes')}
                        onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); handleReview('request_changes'); }}
                        disabled={reviewing}
                        style={{
                          flex: 1, padding: '12px',
                          borderRadius: 12,
                          border: '1px solid rgba(255,59,48,0.15)',
                          background: 'rgba(255,59,48,0.06)',
                          color: '#ff3b30',
                          fontSize: 14, fontWeight: 700,
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
                </div>
              ) : activeTab === 'checks' ? (
                <div>
                  {pr.checks.length === 0 ? (
                    <div style={{ padding: 32, textAlign: 'center', color: '#8e8e93', fontSize: 14 }}>
                      No CI checks configured
                    </div>
                  ) : (
                    pr.checks.map((check, i) => (
                      <CheckRow key={`${check.name}-${i}`} check={check} />
                    ))
                  )}
                </div>
              ) : (
                <div>
                  {pr.files.map((file, i) => (
                    <FileRow key={`${file.path}-${i}`} file={file} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <style>{`
        @keyframes slideUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

function StatusCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      flex: 1, padding: '10px 12px',
      borderRadius: 12,
      background: `${color}08`,
      border: `1px solid ${color}20`,
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: '#8e8e93', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color }}>
        {value}
      </div>
    </div>
  );
}
