'use client';

import { useState, useEffect, useCallback, memo } from 'react';

interface PRData {
  number: number;
  title: string;
  body: string;
  author: string;
  branch: string;
  baseBranch: string;
  state: string;
  mergeable: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  checksStatus: 'success' | 'failure' | 'pending' | 'unknown';
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  files: PRFile[];
  url: string;
}

interface PRFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

interface PRReviewSheetProps {
  open: boolean;
  repoPath: string;
  prNumber: number | null;
  onClose: () => void;
  onViewDiff: (filePath: string) => void;
}

const STATUS_ICONS: Record<PRFile['status'], { color: string; label: string }> = {
  added: { color: '#34c759', label: 'A' },
  modified: { color: '#ff9f0a', label: 'M' },
  deleted: { color: '#ff3b30', label: 'D' },
  renamed: { color: '#af52de', label: 'R' },
};

const CHECK_LABELS: Record<string, { color: string; label: string; icon: string }> = {
  success: { color: '#34c759', label: 'Checks passing', icon: 'M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3' },
  failure: { color: '#ff3b30', label: 'Checks failing', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M15 9l-6 6 M9 9l6 6' },
  pending: { color: '#ff9f0a', label: 'Checks running', icon: 'M12 2v10l4 4 M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z' },
  unknown: { color: '#8e8e93', label: 'No checks', icon: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 16v-4 M12 8h.01' },
};

export const PRReviewSheet = memo(function PRReviewSheet({
  open,
  repoPath,
  prNumber,
  onClose,
  onViewDiff,
}: PRReviewSheetProps) {
  const [pr, setPr] = useState<PRData | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [showComment, setShowComment] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Fetch PR data
  useEffect(() => {
    if (!open || !prNumber || !repoPath) return;
    setLoading(true);
    setError(null);
    setPr(null);

    fetch(`/api/panel/pr?repo=${encodeURIComponent(repoPath)}&number=${prNumber}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          setError(data.error);
        } else {
          setPr(data);
        }
      })
      .catch(() => setError('Failed to load PR'))
      .finally(() => setLoading(false));
  }, [open, prNumber, repoPath]);

  const handleAction = useCallback(async (action: 'approve' | 'request_changes' | 'comment' | 'merge') => {
    if (!pr) return;
    setActionLoading(action);
    setError(null);
    setSuccess(null);

    try {
      const body: Record<string, unknown> = {
        repo: repoPath,
        number: pr.number,
        action,
      };
      if (action === 'comment' || action === 'request_changes') {
        body.comment = comment;
      }

      const res = await fetch('/api/panel/pr/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await res.json();

      if (!res.ok || result.error) {
        setError(result.error || `${action} failed`);
      } else {
        setSuccess(action === 'merge' ? 'PR merged!' : action === 'approve' ? 'Approved!' : 'Review submitted!');
        setComment('');
        setShowComment(false);
        // Refresh PR data
        if (action === 'merge') {
          setTimeout(onClose, 1500);
        }
      }
    } catch {
      setError(`${action} failed`);
    } finally {
      setActionLoading(null);
    }
  }, [pr, repoPath, comment, onClose]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.3)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        zIndex: 9998,
        animation: 'prFadeIn 200ms ease',
      }} />

      {/* Sheet */}
      <div style={{
        position: 'fixed',
        bottom: 0, left: 0, right: 0,
        maxHeight: '90dvh',
        borderRadius: '20px 20px 0 0',
        background: 'rgba(255,255,255,0.92)',
        backdropFilter: 'blur(40px) saturate(1.8)',
        WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
        border: '1px solid rgba(0,122,255,0.08)',
        boxShadow: '0 -8px 40px rgba(0,0,0,0.12)',
        zIndex: 9999,
        display: 'flex', flexDirection: 'column',
        animation: 'prSlideUp 300ms cubic-bezier(0.32, 0.72, 0, 1)',
        overflow: 'hidden',
      }}>
        {/* Drag handle */}
        <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px' }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: 'rgba(0,0,0,0.12)' }} />
        </div>

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '4px 20px 12px',
        }}>
          <h2 style={{
            margin: 0, fontSize: 22, fontWeight: 800,
            fontFamily: '-apple-system, system-ui, sans-serif',
            color: '#0a0a0a', letterSpacing: '-0.03em',
          }}>
            Pull Request
          </h2>
          <button type="button" onClick={onClose} style={{
            width: 28, height: 28, borderRadius: '50%',
            background: 'rgba(0,0,0,0.06)', border: 'none',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            WebkitTapHighlightColor: 'transparent',
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
              stroke="#8e8e93" strokeWidth="3" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div style={{
          flex: 1, overflowY: 'auto', padding: '0 20px 20px',
          WebkitOverflowScrolling: 'touch',
        }}>
          {loading && (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <span style={{
                display: 'inline-block', width: 24, height: 24,
                border: '2px solid rgba(0,122,255,0.15)', borderTopColor: '#007aff',
                borderRadius: '50%', animation: 'prSpin 600ms linear infinite',
              }} />
            </div>
          )}

          {error && !loading && (
            <div style={{
              padding: '10px 14px', borderRadius: 10,
              background: 'rgba(255,59,48,0.06)', border: '1px solid rgba(255,59,48,0.15)',
              color: '#ff3b30', fontSize: 13, fontWeight: 600,
              marginBottom: 12,
            }}>
              {error}
            </div>
          )}

          {success && (
            <div style={{
              padding: '10px 14px', borderRadius: 10,
              background: 'rgba(52,199,89,0.06)', border: '1px solid rgba(52,199,89,0.15)',
              color: '#34c759', fontSize: 13, fontWeight: 600,
              marginBottom: 12,
            }}>
              {success}
            </div>
          )}

          {pr && (
            <>
              {/* PR title + number */}
              <div style={{ marginBottom: 12 }}>
                <h3 style={{
                  margin: 0, fontSize: 17, fontWeight: 700,
                  color: '#0a0a0a', lineHeight: 1.3,
                  fontFamily: '-apple-system, system-ui, sans-serif',
                }}>
                  {pr.title}
                  <span style={{ color: '#8e8e93', fontWeight: 500 }}> #{pr.number}</span>
                </h3>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  marginTop: 6,
                }}>
                  <span style={{
                    padding: '3px 8px', borderRadius: 6,
                    background: 'rgba(0,122,255,0.06)',
                    border: '1px solid rgba(0,122,255,0.1)',
                    fontSize: 11, fontWeight: 600, color: 'rgba(0,80,200,0.7)',
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                  }}>
                    {pr.branch} → {pr.baseBranch}
                  </span>
                  <span style={{ fontSize: 11, color: '#8e8e93' }}>
                    by {pr.author}
                  </span>
                </div>
              </div>

              {/* Stats row */}
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
                gap: 8, marginBottom: 12,
              }}>
                <div style={{
                  padding: '10px', borderRadius: 12, textAlign: 'center',
                  background: 'rgba(52,199,89,0.06)', border: '1px solid rgba(52,199,89,0.1)',
                }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: '#34c759' }}>+{pr.additions}</div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: '#8e8e93' }}>Added</div>
                </div>
                <div style={{
                  padding: '10px', borderRadius: 12, textAlign: 'center',
                  background: 'rgba(255,59,48,0.06)', border: '1px solid rgba(255,59,48,0.1)',
                }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: '#ff3b30' }}>-{pr.deletions}</div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: '#8e8e93' }}>Removed</div>
                </div>
                <div style={{
                  padding: '10px', borderRadius: 12, textAlign: 'center',
                  background: 'rgba(0,122,255,0.06)', border: '1px solid rgba(0,122,255,0.1)',
                }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: '#007aff' }}>{pr.changedFiles}</div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: '#8e8e93' }}>Files</div>
                </div>
              </div>

              {/* Checks + review status */}
              <div style={{
                display: 'flex', gap: 8, marginBottom: 12,
              }}>
                {/* Checks */}
                {(() => {
                  const check = CHECK_LABELS[pr.checksStatus] || CHECK_LABELS.unknown;
                  return (
                    <div style={{
                      flex: 1, padding: '10px 12px', borderRadius: 12,
                      background: `${check.color}08`,
                      border: `1px solid ${check.color}18`,
                      display: 'flex', alignItems: 'center', gap: 8,
                    }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                        stroke={check.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d={check.icon} />
                      </svg>
                      <span style={{ fontSize: 12, fontWeight: 600, color: check.color }}>
                        {check.label}
                      </span>
                    </div>
                  );
                })()}

                {/* Review decision */}
                {pr.reviewDecision && (
                  <div style={{
                    flex: 1, padding: '10px 12px', borderRadius: 12,
                    background: pr.reviewDecision === 'APPROVED' ? 'rgba(52,199,89,0.08)' : 'rgba(255,149,0,0.08)',
                    border: `1px solid ${pr.reviewDecision === 'APPROVED' ? 'rgba(52,199,89,0.18)' : 'rgba(255,149,0,0.18)'}`,
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                      stroke={pr.reviewDecision === 'APPROVED' ? '#34c759' : '#ff9500'}
                      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {pr.reviewDecision === 'APPROVED'
                        ? <polyline points="20 6 9 17 4 12" />
                        : <><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>
                      }
                    </svg>
                    <span style={{
                      fontSize: 12, fontWeight: 600,
                      color: pr.reviewDecision === 'APPROVED' ? '#34c759' : '#ff9500',
                    }}>
                      {pr.reviewDecision === 'APPROVED' ? 'Approved' : 'Changes requested'}
                    </span>
                  </div>
                )}
              </div>

              {/* Files list */}
              <label style={{
                display: 'block', fontSize: 12, fontWeight: 700,
                color: '#8e8e93', textTransform: 'uppercase',
                letterSpacing: '0.05em', marginBottom: 6,
              }}>
                Changed Files
              </label>
              <div style={{
                borderRadius: 12, overflow: 'hidden',
                border: '1px solid rgba(0,122,255,0.08)',
              }}>
                {pr.files.map((file, i) => {
                  const status = STATUS_ICONS[file.status] || STATUS_ICONS.modified;
                  return (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => onViewDiff(file.path)}
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        border: 'none',
                        borderTop: i > 0 ? '1px solid rgba(0,0,0,0.04)' : 'none',
                        background: 'rgba(0,122,255,0.02)',
                        display: 'flex', alignItems: 'center', gap: 8,
                        cursor: 'pointer',
                        WebkitTapHighlightColor: 'transparent',
                        textAlign: 'left',
                      }}
                    >
                      <span style={{
                        width: 18, height: 18, borderRadius: 4,
                        background: `${status.color}15`,
                        color: status.color,
                        fontSize: 10, fontWeight: 800,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                      }}>
                        {status.label}
                      </span>
                      <span style={{
                        flex: 1, minWidth: 0,
                        fontSize: 12, fontWeight: 500,
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                        color: '#0a0a0a',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {file.path}
                      </span>
                      <span style={{
                        fontSize: 10, fontWeight: 600, color: '#34c759', flexShrink: 0,
                      }}>
                        +{file.additions}
                      </span>
                      <span style={{
                        fontSize: 10, fontWeight: 600, color: '#ff3b30', flexShrink: 0,
                      }}>
                        -{file.deletions}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Comment input */}
              {showComment && (
                <div style={{ marginTop: 12 }}>
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="Leave a review comment..."
                    rows={3}
                    style={{
                      width: '100%', padding: '10px 14px',
                      borderRadius: 12,
                      border: '1px solid rgba(0,122,255,0.12)',
                      background: 'rgba(0,122,255,0.03)',
                      color: '#0a0a0a', fontSize: 14,
                      fontFamily: '-apple-system, system-ui, sans-serif',
                      resize: 'none', outline: 'none',
                      lineHeight: 1.5, boxSizing: 'border-box',
                    }}
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Action buttons — fixed at bottom */}
        {pr && (
          <div style={{
            padding: '12px 20px',
            paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
            borderTop: '1px solid rgba(0,0,0,0.04)',
            display: 'flex', gap: 8,
          }}>
            {/* Comment toggle */}
            <button
              type="button"
              onClick={() => {
                if (showComment && comment.trim()) {
                  handleAction('comment');
                } else {
                  setShowComment(v => !v);
                }
              }}
              style={{
                flex: 1, padding: '12px',
                borderRadius: 12,
                border: '1px solid rgba(0,122,255,0.15)',
                background: 'rgba(0,122,255,0.06)',
                color: '#007aff', fontSize: 13, fontWeight: 700,
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              {actionLoading === 'comment' ? '…' : showComment && comment.trim() ? 'Submit' : 'Comment'}
            </button>

            {/* Approve */}
            <button
              type="button"
              onClick={() => handleAction('approve')}
              disabled={actionLoading !== null}
              style={{
                flex: 1, padding: '12px',
                borderRadius: 12, border: 'none',
                background: '#34c759', color: '#fff',
                fontSize: 13, fontWeight: 700,
                cursor: actionLoading ? 'default' : 'pointer',
                opacity: actionLoading ? 0.6 : 1,
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              {actionLoading === 'approve' ? '…' : 'Approve'}
            </button>

            {/* Merge */}
            {pr.mergeable && (
              <button
                type="button"
                onClick={() => handleAction('merge')}
                disabled={actionLoading !== null}
                style={{
                  flex: 1, padding: '12px',
                  borderRadius: 12, border: 'none',
                  background: '#af52de', color: '#fff',
                  fontSize: 13, fontWeight: 700,
                  cursor: actionLoading ? 'default' : 'pointer',
                  opacity: actionLoading ? 0.6 : 1,
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                {actionLoading === 'merge' ? '…' : 'Merge'}
              </button>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes prSlideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
        @keyframes prFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes prSpin { to { transform: rotate(360deg); } }
      `}</style>
    </>
  );
});
