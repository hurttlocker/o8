'use client';

/**
 * ApprovalQueuePanel — First-class governance surface.
 *
 * Shows pending approvals prominently with policy context, risk badges,
 * diff previews, and approve/deny actions. This replaces ThoughtsCard
 * as the primary approval destination.
 *
 * Apple HIG: clean cards, minimal color, 14px radii, 44px touch targets.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { ApprovalRecord } from '@/lib/approvals/types';

const POLL_INTERVAL = 5_000; // 5s — approvals are urgent
const HISTORY_LIMIT = 20;

// ── Risk colors ──

const RISK_COLORS: Record<string, { bg: string; text: string; badge: string }> = {
  high: {
    bg: 'rgba(239, 68, 68, 0.06)',
    text: '#dc2626',
    badge: 'rgba(239, 68, 68, 0.1)',
  },
  medium: {
    bg: 'rgba(245, 158, 11, 0.06)',
    text: '#d97706',
    badge: 'rgba(245, 158, 11, 0.1)',
  },
  low: {
    bg: 'rgba(37, 99, 235, 0.06)',
    text: '#2563eb',
    badge: 'rgba(37, 99, 235, 0.1)',
  },
};

function riskColor(risk: string) {
  return RISK_COLORS[risk] ?? RISK_COLORS.low;
}

// ── Relative time ──

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// ── Shield Icon (inline SVG for Tauri compat) ──

function ShieldIcon({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function ClockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

// ── Diff Preview ──

function DiffPreview({ diff }: { diff: { before?: string; after?: string; path?: string } }) {
  const [expanded, setExpanded] = useState(false);
  const before = diff.before || '';
  const after = diff.after || '';
  const isNew = !before && after;
  const lineCount = after.split('\n').length;

  return (
    <div style={{ marginTop: 8 }}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          borderRadius: 8,
          border: '1px solid var(--t-divider)',
          background: 'var(--t-code-bg, rgba(0,0,0,0.03))',
          color: 'var(--t-text-secondary)',
          cursor: 'pointer',
          fontSize: 11,
          fontFamily: 'SF Mono, Menlo, monospace',
        }}
      >
        <span>{expanded ? '\u25BC' : '\u25B6'}</span>
        <span>{diff.path || 'diff'}</span>
        <span style={{ color: 'var(--t-text-tertiary)' }}>
          {isNew ? `+${lineCount} lines` : 'changes'}
        </span>
      </button>
      {expanded && (
        <pre style={{
          marginTop: 6,
          padding: 10,
          borderRadius: 10,
          background: 'var(--t-code-bg, rgba(0,0,0,0.03))',
          border: '1px solid var(--t-divider)',
          fontSize: 11,
          fontFamily: 'SF Mono, Menlo, monospace',
          lineHeight: 1.5,
          overflowX: 'auto',
          maxHeight: 200,
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: 'var(--t-text)',
        }}>
          {before && (
            <div style={{ color: '#dc2626' }}>
              {before.split('\n').map((line, i) => (
                <div key={`rm-${i}`}>- {line}</div>
              ))}
            </div>
          )}
          {after && (
            <div style={{ color: '#16a34a' }}>
              {after.split('\n').map((line, i) => (
                <div key={`add-${i}`}>+ {line}</div>
              ))}
            </div>
          )}
        </pre>
      )}
    </div>
  );
}

// ── Approval Card ──

function ApprovalCard({
  approval,
  resolving,
  onResolve,
}: {
  approval: ApprovalRecord;
  resolving: boolean;
  onResolve: (id: string, action: 'approve' | 'reject') => void;
}) {
  const colors = riskColor(approval.risk);
  const isPending = approval.status === 'pending';

  return (
    <div style={{
      padding: 16,
      borderRadius: 14,
      background: isPending ? 'var(--t-panel)' : 'var(--t-bg)',
      border: `1px solid ${isPending ? colors.badge : 'var(--t-divider)'}`,
      opacity: isPending ? 1 : 0.7,
    }}>
      {/* Header: risk badge + title + time */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          borderRadius: 10,
          background: colors.bg,
          flexShrink: 0,
        }}>
          <ShieldIcon size={16} color={colors.text} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}>
            <span style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--t-text)',
              letterSpacing: '-0.01em',
            }}>
              {approval.title}
            </span>
            <span style={{
              fontSize: 10,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: colors.text,
              background: colors.badge,
              padding: '2px 6px',
              borderRadius: 6,
            }}>
              {approval.risk}
            </span>
            {approval.policyRuleId && approval.policyRuleId !== 'default-allow' && (
              <span style={{
                fontSize: 10,
                color: 'var(--t-text-tertiary)',
                fontFamily: 'SF Mono, Menlo, monospace',
              }}>
                {approval.policyRuleId}
              </span>
            )}
          </div>

          {/* Agent + time */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 2,
            fontSize: 11,
            color: 'var(--t-text-secondary)',
          }}>
            <span>{approval.agent}</span>
            <span style={{ color: 'var(--t-text-tertiary)' }}>&middot;</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <ClockIcon />
              {timeAgo(approval.createdAt)}
            </span>
          </div>
        </div>
      </div>

      {/* Description */}
      <div style={{
        marginTop: 10,
        fontSize: 12,
        lineHeight: 1.5,
        color: 'var(--t-text-secondary)',
      }}>
        {approval.description}
      </div>

      {/* Command preview */}
      {approval.command && (
        <div style={{
          marginTop: 8,
          padding: '6px 10px',
          borderRadius: 8,
          background: 'var(--t-code-bg, rgba(0,0,0,0.03))',
          border: '1px solid var(--t-divider)',
          fontFamily: 'SF Mono, Menlo, monospace',
          fontSize: 11,
          color: 'var(--t-text)',
          overflowX: 'auto',
          whiteSpace: 'nowrap',
        }}>
          $ {approval.command}
        </div>
      )}

      {/* Diff preview */}
      {approval.diff && <DiffPreview diff={approval.diff} />}

      {/* Metadata */}
      {approval.metadata && Object.keys(approval.metadata).length > 0 && (
        <div style={{
          marginTop: 8,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
        }}>
          {Object.entries(approval.metadata).map(([key, value]) => (
            <span
              key={key}
              style={{
                fontSize: 10,
                padding: '2px 6px',
                borderRadius: 6,
                background: 'var(--t-code-bg, rgba(0,0,0,0.03))',
                color: 'var(--t-text-secondary)',
                fontFamily: 'SF Mono, Menlo, monospace',
              }}
            >
              {key}: {value}
            </span>
          ))}
        </div>
      )}

      {/* Actions */}
      {isPending && (
        <div style={{
          marginTop: 12,
          display: 'flex',
          gap: 8,
        }}>
          <button
            type="button"
            disabled={resolving}
            onClick={() => onResolve(approval.id, 'approve')}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              flex: 1,
              minHeight: 44,
              borderRadius: 12,
              border: 'none',
              background: '#22c55e',
              color: '#fff',
              fontSize: 13,
              fontWeight: 600,
              cursor: resolving ? 'wait' : 'pointer',
              opacity: resolving ? 0.6 : 1,
              transition: 'opacity 150ms ease',
              letterSpacing: '-0.01em',
            }}
          >
            <CheckIcon />
            {resolving ? 'Resolving...' : 'Approve'}
          </button>
          <button
            type="button"
            disabled={resolving}
            onClick={() => onResolve(approval.id, 'reject')}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              flex: 1,
              minHeight: 44,
              borderRadius: 12,
              border: '1px solid rgba(239, 68, 68, 0.3)',
              background: 'rgba(239, 68, 68, 0.06)',
              color: '#ef4444',
              fontSize: 13,
              fontWeight: 600,
              cursor: resolving ? 'wait' : 'pointer',
              opacity: resolving ? 0.6 : 1,
              transition: 'opacity 150ms ease',
              letterSpacing: '-0.01em',
            }}
          >
            <XIcon />
            Deny
          </button>
        </div>
      )}

      {/* Resolved status */}
      {!isPending && approval.resolution && (
        <div style={{
          marginTop: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: approval.resolution.action === 'approved' ? '#16a34a' : '#dc2626',
          fontWeight: 500,
        }}>
          {approval.resolution.action === 'approved' ? <CheckIcon size={12} /> : <XIcon size={12} />}
          {approval.resolution.action === 'approved' ? 'Approved' : 'Denied'}
          {' by '}
          {approval.resolution.actor}
          {approval.resolvedAt && (
            <span style={{ color: 'var(--t-text-tertiary)' }}>
              &middot; {timeAgo(approval.resolvedAt)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Empty State ──

function EmptyState() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '60px 24px',
      gap: 12,
    }}>
      <div style={{
        width: 48,
        height: 48,
        borderRadius: 14,
        background: 'rgba(34, 197, 94, 0.08)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <ShieldIcon size={24} color="#22c55e" />
      </div>
      <div style={{
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--t-text)',
        letterSpacing: '-0.01em',
      }}>
        All clear
      </div>
      <div style={{
        fontSize: 12,
        color: 'var(--t-text-secondary)',
        textAlign: 'center',
        maxWidth: 240,
        lineHeight: 1.5,
      }}>
        No pending approvals. Agents are working within policy.
      </div>
    </div>
  );
}

// ── Main Panel ──

export function ApprovalQueuePanel() {
  const [pending, setPending] = useState<ApprovalRecord[]>([]);
  const [history, setHistory] = useState<ApprovalRecord[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch approvals
  const fetchApprovals = useCallback(async () => {
    try {
      const [pendingRes, historyRes] = await Promise.all([
        fetch('/api/panel/approvals'),
        fetch('/api/panel/approvals?status=all'),
      ]);
      if (pendingRes.ok) {
        const data = await pendingRes.json();
        setPending(data.approvals ?? []);
      }
      if (historyRes.ok) {
        const data = await historyRes.json();
        const resolved = (data.approvals ?? [])
          .filter((a: ApprovalRecord) => a.status !== 'pending')
          .slice(0, HISTORY_LIMIT);
        setHistory(resolved);
      }
    } catch {
      // Silently fail — next poll will retry
    }
  }, []);

  useEffect(() => {
    fetchApprovals();
    pollRef.current = setInterval(fetchApprovals, POLL_INTERVAL);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchApprovals]);

  // Resolve approval
  const handleResolve = useCallback(async (id: string, action: 'approve' | 'reject') => {
    setResolvingId(id);
    try {
      const res = await fetch('/api/panel/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id }),
      });
      if (res.ok) {
        // Move from pending to history
        setPending((current) => current.filter((a) => a.id !== id));
        await fetchApprovals(); // Refresh history
      }
    } catch {
      // Will show on next poll
    }
    setResolvingId(null);
  }, [fetchApprovals]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'var(--t-bg)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '16px 20px 12px',
        borderBottom: '1px solid var(--t-divider)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ShieldIcon size={18} color="var(--t-text)" />
          <span style={{
            fontSize: 15,
            fontWeight: 700,
            color: 'var(--t-text)',
            letterSpacing: '-0.02em',
          }}>
            Approvals
          </span>
          {pending.length > 0 && (
            <span style={{
              fontSize: 11,
              fontWeight: 700,
              color: '#fff',
              background: '#ef4444',
              padding: '1px 7px',
              borderRadius: 10,
              lineHeight: '18px',
            }}>
              {pending.length}
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '12px 16px',
      }}>
        {/* Pending approvals */}
        {pending.length === 0 ? (
          <EmptyState />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {pending.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                resolving={resolvingId === approval.id}
                onResolve={handleResolve}
              />
            ))}
          </div>
        )}

        {/* History toggle */}
        {history.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <button
              type="button"
              onClick={() => setShowHistory(!showHistory)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 0',
                border: 'none',
                background: 'none',
                color: 'var(--t-text-secondary)',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              <span style={{
                transition: 'transform 150ms ease',
                transform: showHistory ? 'rotate(90deg)' : 'rotate(0deg)',
                display: 'inline-block',
              }}>
                {'\u25B6'}
              </span>
              Recent decisions ({history.length})
            </button>

            {showHistory && (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                marginTop: 8,
              }}>
                {history.map((approval) => (
                  <ApprovalCard
                    key={approval.id}
                    approval={approval}
                    resolving={false}
                    onResolve={() => {}}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ApprovalQueuePanel;
