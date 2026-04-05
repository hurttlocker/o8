'use client';

/**
 * O8PRPane — Pull request review pane for the O8 panel.
 *
 * Fetches PR detail from /api/panel/prs/[number], renders header with
 * branch info + stats, collapsible file diffs, and approve/merge actions.
 * Apple-minimal: dense but readable, no clutter.
 */

import { useCallback, useEffect, useState } from 'react';

// ── Types ──

interface PRFile {
  path: string;
  additions: number;
  deletions: number;
  status?: string;
}

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
  mergedAt: string | null;
  files: PRFile[];
  diffStat: string;
  url: string;
  reviewComments: Array<{ id: number; body: string; user: string; path: string; line: number | null }>;
}

interface O8PRPaneProps {
  prNumber?: number | null;
  repo?: string | null;
  onClose?: () => void;
}

// ── Icons ──

function GitMergeIcon({ size = 14, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </svg>
  );
}

function CheckIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function FileIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function ChevronIcon({ open, size = 10 }: { open: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', transition: 'transform 120ms ease', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// ── Diff stat bar ──

function DiffBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  if (total === 0) return null;
  const addPct = Math.round((additions / total) * 100);
  return (
    <div style={{ display: 'flex', width: 40, height: 4, borderRadius: 2, overflow: 'hidden', flexShrink: 0 }}>
      <div style={{ width: `${addPct}%`, background: '#22c55e' }} />
      <div style={{ flex: 1, background: '#ef4444' }} />
    </div>
  );
}

// ── State badge ──

function StateBadge({ state, merged }: { state: string; merged: boolean }) {
  if (merged) return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 8px', borderRadius: 999, background: 'rgba(139, 92, 246, 0.15)', color: '#8b5cf6', fontSize: 10, fontWeight: 700 }}><GitMergeIcon size={10} color="#8b5cf6" />Merged</span>;
  if (state === 'open') return <span style={{ padding: '2px 8px', borderRadius: 999, background: 'rgba(34, 197, 94, 0.15)', color: '#22c55e', fontSize: 10, fontWeight: 700 }}>Open</span>;
  return <span style={{ padding: '2px 8px', borderRadius: 999, background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444', fontSize: 10, fontWeight: 700 }}>Closed</span>;
}

// ── PR List Item (summary card) ──

interface PRSummary {
  number: number;
  title: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  state: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string | null;
  url: string;
}

function PRListItem({ pr, active, onClick }: { pr: PRSummary; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        width: '100%',
        padding: '10px 14px',
        border: 'none',
        borderBottom: '1px solid var(--t-divider-subtle)',
        background: active ? 'rgba(37, 99, 235, 0.08)' : 'transparent',
        color: 'var(--t-text)',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: '-apple-system, system-ui, sans-serif',
        transition: 'background 80ms ease',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      <GitMergeIcon size={14} color={pr.state === 'open' ? '#22c55e' : '#8b5cf6'} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {pr.title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, fontSize: 10, color: 'var(--t-text-faint)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
          <span>#{pr.number}</span>
          <span>&middot;</span>
          <span>{pr.baseRefName} &larr; {pr.headRefName}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, fontSize: 10 }}>
          <span style={{ color: 'var(--t-text-secondary)' }}>{pr.author}</span>
          <span style={{ color: 'var(--t-text-faint)' }}>&middot;</span>
          <span style={{ color: '#22c55e', fontWeight: 600 }}>+{pr.additions}</span>
          <span style={{ color: '#ef4444', fontWeight: 600 }}>-{pr.deletions}</span>
          <DiffBar additions={pr.additions} deletions={pr.deletions} />
          <span style={{ color: 'var(--t-text-faint)' }}>{pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'}</span>
        </div>
      </div>
    </button>
  );
}

// ── Main ──

export function O8PRPane({ prNumber, repo }: O8PRPaneProps) {
  const [pr, setPr] = useState<PRDetail | null>(null);
  const [prList, setPrList] = useState<PRSummary[]>([]);
  const [prListLoading, setPrListLoading] = useState(false);
  const [selectedPr, setSelectedPr] = useState<number | null>(prNumber ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [fileDiffs, setFileDiffs] = useState<Map<string, string>>(new Map());
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [reviewComment, setReviewComment] = useState('');

  // Sync external prNumber
  useEffect(() => {
    if (prNumber) setSelectedPr(prNumber);
  }, [prNumber]);

  // Fetch all open PRs for the repo
  useEffect(() => {
    setPrListLoading(true);
    const repoParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    fetch(`/api/panel/prs${repoParam}`)
      .then((r) => r.json())
      .then((data) => setPrList(data.prs ?? []))
      .catch(() => {})
      .finally(() => setPrListLoading(false));
  }, [repo]);

  // Fetch PR detail when one is selected
  useEffect(() => {
    if (!selectedPr) { setPr(null); return; }
    setLoading(true);
    setError(null);
    setPr(null);
    const repoParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    fetch(`/api/panel/prs/${selectedPr}${repoParam}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.pr) setPr(data.pr);
        else setError(data.error || 'PR not found');
      })
      .catch(() => setError('Failed to fetch PR'))
      .finally(() => setLoading(false));
  }, [selectedPr, repo]);

  // Fetch individual file diff
  const handleToggleFile = useCallback((filePath: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
        // Fetch diff if not cached
        if (!fileDiffs.has(filePath) && pr) {
          const repoParam = repo ? `&repo=${encodeURIComponent(repo)}` : '';
          fetch(`/api/panel/pr?number=${pr.number}${repoParam}`)
            .then((r) => r.json())
            .then(() => {
              // Use diffStat as fallback — individual file diffs from git
              setFileDiffs((m) => new Map(m).set(filePath, `File: ${filePath}`));
            })
            .catch(() => {});
        }
      }
      return next;
    });
  }, [fileDiffs, pr, repo]);

  // Submit review action
  const handleAction = useCallback(async (action: 'approve' | 'request_changes' | 'merge') => {
    if (!pr) return;
    setActionLoading(action);
    setActionResult(null);
    try {
      const res = await fetch('/api/panel/pr/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: repo || undefined,
          number: pr.number,
          action,
          comment: reviewComment || undefined,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setActionResult(action === 'approve' ? 'Approved' : action === 'merge' ? 'Merged' : 'Changes requested');
        setReviewComment('');
      } else {
        setActionResult(data.error || 'Action failed');
      }
    } catch {
      setActionResult('Action failed');
    } finally {
      setActionLoading(null);
    }
  }, [pr, repo, reviewComment]);

  // No PR selected — show the list of all open PRs
  if (!selectedPr) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div style={{
          padding: '8px 14px',
          borderBottom: '1px solid var(--t-divider-subtle)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <GitMergeIcon size={13} color="var(--t-text-secondary)" />
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
            Pull Requests
          </span>
          {prList.length > 0 ? (
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              minWidth: 18, height: 18, padding: '0 6px', borderRadius: 999,
              background: 'var(--t-divider-subtle)', color: 'var(--t-text-secondary)',
              fontSize: 10, fontWeight: 700, fontFamily: '"SF Mono", ui-monospace, monospace',
            }}>
              {prList.length}
            </span>
          ) : null}
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {prListLoading ? (
            <div style={{ padding: '20px 14px', color: 'var(--t-text-faint)', fontSize: 12, textAlign: 'center' }}>Loading pull requests...</div>
          ) : prList.length === 0 ? (
            <div style={{ padding: '40px 14px', textAlign: 'center', color: 'var(--t-text-faint)' }}>
              <GitMergeIcon size={28} color="var(--t-text-faint)" />
              <div style={{ marginTop: 8, fontSize: 12, fontWeight: 500 }}>No open pull requests</div>
            </div>
          ) : (
            prList.map((item) => (
              <PRListItem key={item.number} pr={item} active={false} onClick={() => setSelectedPr(item.number)} />
            ))
          )}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-text-faint)', fontSize: 12 }}>
        Loading PR #{selectedPr}...
      </div>
    );
  }

  if (error || !pr) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ef4444', fontSize: 12 }}>
        {error || 'PR not found'}
      </div>
    );
  }

  const isMerged = Boolean(pr.mergedAt);
  const canAct = pr.state === 'open' && !isMerged;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {/* PR Header */}
      <div style={{
        padding: '12px 14px',
        borderBottom: '1px solid var(--t-divider-subtle)',
        flexShrink: 0,
      }}>
        {/* Back button */}
        <button
          type="button"
          onClick={() => setSelectedPr(null)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: 0,
            marginBottom: 6,
            border: 'none',
            background: 'transparent',
            color: 'var(--t-text-faint)',
            fontSize: 10,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: '-apple-system, system-ui, sans-serif',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--t-text-secondary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--t-text-faint)'; }}
        >
          &larr; All PRs
        </button>
        {/* Title row */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <GitMergeIcon size={16} color={isMerged ? '#8b5cf6' : '#22c55e'} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 13,
              fontWeight: 700,
              color: 'var(--t-text)',
              letterSpacing: '-0.01em',
              lineHeight: 1.3,
            }}>
              {pr.title}
            </div>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 4,
              fontSize: 11,
              color: 'var(--t-text-secondary)',
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}>
              <span>{pr.baseRefName}</span>
              <span style={{ color: 'var(--t-text-faint)' }}>&larr;</span>
              <span>{pr.headRefName}</span>
            </div>
          </div>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text-faint)', flexShrink: 0 }}>#{pr.number}</span>
        </div>

        {/* Stats row */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginTop: 8,
          fontSize: 11,
        }}>
          <StateBadge state={pr.state} merged={isMerged} />
          <span style={{ color: 'var(--t-text-secondary)' }}>{pr.author?.login}</span>
          <span style={{ color: 'var(--t-text-faint)' }}>&middot;</span>
          <span style={{ color: '#22c55e', fontWeight: 600 }}>+{pr.additions}</span>
          <span style={{ color: '#ef4444', fontWeight: 600 }}>-{pr.deletions}</span>
          <DiffBar additions={pr.additions} deletions={pr.deletions} />
          <span style={{ color: 'var(--t-text-faint)' }}>{pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'}</span>
        </div>
      </div>

      {/* Files list */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {pr.files.map((file) => {
          const isExpanded = expandedFiles.has(file.path);
          return (
            <div key={file.path}>
              <button
                type="button"
                onClick={() => handleToggleFile(file.path)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  width: '100%',
                  padding: '6px 14px',
                  border: 'none',
                  borderBottom: '1px solid var(--t-divider-subtle)',
                  background: isExpanded ? 'rgba(37, 99, 235, 0.06)' : 'transparent',
                  color: 'var(--t-text)',
                  cursor: 'pointer',
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                  fontSize: 11,
                  textAlign: 'left',
                }}
                onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.background = 'transparent'; }}
              >
                <ChevronIcon open={isExpanded} size={9} />
                <FileIcon size={12} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {file.path}
                </span>
                <span style={{ color: '#22c55e', fontSize: 10, fontWeight: 600, flexShrink: 0 }}>+{file.additions}</span>
                <span style={{ color: '#ef4444', fontSize: 10, fontWeight: 600, flexShrink: 0 }}>-{file.deletions}</span>
                <DiffBar additions={file.additions} deletions={file.deletions} />
              </button>
              {isExpanded ? (
                <div style={{
                  padding: '8px 14px 8px 36px',
                  borderBottom: '1px solid var(--t-divider-subtle)',
                  background: 'rgba(0,0,0,0.15)',
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                  fontSize: 11,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  color: 'var(--t-text-secondary)',
                }}>
                  {/* Show diff stat lines for this file from the PR diffStat */}
                  {pr.diffStat
                    .split('\n')
                    .filter((line) => line.includes(file.path.split('/').pop() ?? ''))
                    .map((line, i) => <div key={i}>{line}</div>)
                  }
                  {/* Review comments on this file */}
                  {pr.reviewComments
                    .filter((c) => c.path === file.path)
                    .map((comment) => (
                      <div key={comment.id} style={{
                        marginTop: 8,
                        padding: '6px 10px',
                        borderRadius: 8,
                        background: 'rgba(37, 99, 235, 0.08)',
                        border: '1px solid rgba(37, 99, 235, 0.15)',
                      }}>
                        <div style={{ fontSize: 10, fontWeight: 600, color: '#3b82f6', marginBottom: 2 }}>
                          {comment.user} {comment.line ? `· L${comment.line}` : ''}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--t-text)', whiteSpace: 'pre-wrap' }}>{comment.body}</div>
                      </div>
                    ))
                  }
                  {pr.reviewComments.filter((c) => c.path === file.path).length === 0 && !pr.diffStat.includes(file.path.split('/').pop() ?? '') ? (
                    <span style={{ color: 'var(--t-text-faint)' }}>No inline comments</span>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Action bar */}
      {canAct ? (
        <div style={{
          padding: '10px 14px',
          borderTop: '1px solid var(--t-divider-subtle)',
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          {/* Comment input */}
          <textarea
            value={reviewComment}
            onChange={(e) => setReviewComment(e.target.value)}
            placeholder="Review comment (optional)..."
            rows={2}
            style={{
              width: '100%',
              resize: 'vertical',
              border: '1px solid var(--t-divider)',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--t-text)',
              fontFamily: '-apple-system, system-ui, sans-serif',
              fontSize: 12,
              padding: '6px 10px',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            {actionResult ? (
              <span style={{ fontSize: 11, color: '#22c55e', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, marginRight: 'auto' }}>
                <CheckIcon size={11} /> {actionResult}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => void handleAction('request_changes')}
              disabled={actionLoading !== null}
              style={{
                padding: '5px 12px',
                borderRadius: 8,
                border: '1px solid var(--t-divider)',
                background: 'transparent',
                color: 'var(--t-text-secondary)',
                fontSize: 11,
                fontWeight: 600,
                cursor: actionLoading ? 'wait' : 'pointer',
                opacity: actionLoading ? 0.6 : 1,
              }}
            >
              Request Changes
            </button>
            <button
              type="button"
              onClick={() => void handleAction('approve')}
              disabled={actionLoading !== null}
              style={{
                padding: '5px 12px',
                borderRadius: 8,
                border: '1px solid var(--t-divider)',
                background: 'rgba(255, 255, 255, 0.06)',
                color: 'var(--t-text)',
                fontSize: 11,
                fontWeight: 600,
                cursor: actionLoading ? 'wait' : 'pointer',
                opacity: actionLoading ? 0.6 : 1,
              }}
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => void handleAction('merge')}
              disabled={actionLoading !== null}
              style={{
                padding: '5px 12px',
                borderRadius: 8,
                border: '1px solid var(--t-divider)',
                background: 'rgba(255, 255, 255, 0.1)',
                color: 'var(--t-text)',
                fontSize: 11,
                fontWeight: 600,
                cursor: actionLoading ? 'wait' : 'pointer',
                opacity: actionLoading ? 0.6 : 1,
              }}
            >
              Merge
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
