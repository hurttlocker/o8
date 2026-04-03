'use client';

import { useCallback, useEffect, useState } from 'react';

interface ApprovalItem {
  id: string;
  title: string;
  description?: string;
  summary?: string;
  risk: 'low' | 'medium' | 'high';
  toolName?: string;
  sessionKey?: string;
  status: string;
  createdAt: number;
  metadata?: Record<string, string>;
}

const RISK_COLORS: Record<string, string> = {
  high: '#ef4444',
  medium: '#f59e0b',
  low: '#22c55e',
};

const POLL_INTERVAL = 5_000;

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function RiskBadge({ risk }: { risk: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.02em',
        textTransform: 'uppercase',
        color: '#fff',
        backgroundColor: RISK_COLORS[risk] ?? RISK_COLORS.low,
      }}
    >
      {risk}
    </span>
  );
}

function ApprovalCard({
  approval,
  onResolve,
  resolving,
}: {
  approval: ApprovalItem;
  onResolve: (id: string, action: 'approve' | 'reject') => void;
  resolving: string | null;
}) {
  const isResolving = resolving === approval.id;
  const agent = approval.metadata?.agent ?? approval.sessionKey?.split(':').pop() ?? 'agent';

  return (
    <div
      style={{
        backgroundColor: 'rgba(255,255,255,0.06)',
        borderRadius: 14,
        padding: 16,
        marginBottom: 12,
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <RiskBadge risk={approval.risk} />
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{timeAgo(approval.createdAt)}</span>
      </div>

      <div style={{ fontSize: 15, fontWeight: 600, color: '#f3f4f6', marginBottom: 4, lineHeight: 1.3 }}>
        {approval.title}
      </div>

      {approval.toolName && (
        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 4, fontFamily: 'SF Mono, Menlo, monospace' }}>
          {approval.toolName}
        </div>
      )}

      <div style={{ fontSize: 13, color: '#d1d5db', marginBottom: 4 }}>
        {agent}
      </div>

      {approval.summary && (
        <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 12, lineHeight: 1.4 }}>
          {approval.summary.length > 200 ? `${approval.summary.slice(0, 200)}...` : approval.summary}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => onResolve(approval.id, 'approve')}
          disabled={isResolving}
          style={{
            flex: 1,
            height: 44,
            borderRadius: 12,
            border: 'none',
            backgroundColor: '#22c55e',
            color: '#fff',
            fontSize: 15,
            fontWeight: 600,
            cursor: isResolving ? 'default' : 'pointer',
            opacity: isResolving ? 0.5 : 1,
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          {isResolving ? 'Approving...' : 'Approve'}
        </button>
        <button
          onClick={() => onResolve(approval.id, 'reject')}
          disabled={isResolving}
          style={{
            flex: 1,
            height: 44,
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.15)',
            backgroundColor: 'transparent',
            color: '#f87171',
            fontSize: 15,
            fontWeight: 600,
            cursor: isResolving ? 'default' : 'pointer',
            opacity: isResolving ? 0.5 : 1,
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

export function MobileApprovalsClient({ initialApprovals }: { initialApprovals: ApprovalItem[] }) {
  const [approvals, setApprovals] = useState<ApprovalItem[]>(initialApprovals);
  const [resolving, setResolving] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now());
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/panel/approvals?status=pending', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json() as { approvals?: ApprovalItem[] };
        setApprovals(data.approvals ?? []);
        setError(null);
      }
    } catch {
      setError('Unable to reach server');
    }
    setLastRefresh(Date.now());
  }, []);

  // Poll for new approvals
  useEffect(() => {
    const timer = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleResolve = useCallback(async (id: string, action: 'approve' | 'reject') => {
    setResolving(id);
    try {
      const res = await fetch('/api/panel/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id }),
      });
      if (res.ok) {
        setApprovals((prev) => prev.filter((a) => a.id !== id));
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? 'Failed to resolve approval');
      }
    } catch {
      setError('Unable to reach server');
    }
    setResolving(null);
  }, []);

  const pending = approvals.filter((a) => a.status === 'pending');

  return (
    <div
      style={{
        minHeight: '100dvh',
        backgroundColor: '#111111',
        color: '#f3f4f6',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        WebkitFontSmoothing: 'antialiased',
        padding: '0 16px',
      } as React.CSSProperties}
    >
      {/* Header */}
      <div
        style={{
          paddingTop: 'max(env(safe-area-inset-top, 0px), 16px)',
          paddingBottom: 12,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        } as React.CSSProperties}
      >
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>o8</div>
          <div style={{ fontSize: 13, color: '#6b7280' }}>
            {pending.length} pending approval{pending.length !== 1 ? 's' : ''}
          </div>
        </div>
        <button
          onClick={() => void refresh()}
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.1)',
            backgroundColor: 'transparent',
            color: '#9ca3af',
            fontSize: 18,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'system-ui',
          }}
          aria-label="Refresh"
        >
          <svg width="18" height="18" viewBox="0 0 256 256" fill="currentColor">
            <path d="M228,48V96a4,4,0,0,1-4,4H176a4,4,0,0,1,0-8h39.37L184.2,60.84a92,92,0,0,0-152.37,18,4,4,0,1,1-7.31-3.24A100,100,0,0,1,189.94,55.94L220,86.06V48a4,4,0,0,1,8,0ZM231.48,180.36a100,100,0,0,1-165.42,19.7L36,170.06V208a4,4,0,0,1-8,0V160a4,4,0,0,1,4-4H80a4,4,0,0,1,0,8H40.63l31.17,31.16A92,92,0,0,0,224.17,177.2a4,4,0,1,1,7.31,3.16Z" />
          </svg>
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div
          style={{
            backgroundColor: 'rgba(239,68,68,0.15)',
            borderRadius: 10,
            padding: '8px 12px',
            marginBottom: 12,
            fontSize: 13,
            color: '#f87171',
          }}
        >
          {error}
        </div>
      )}

      {/* Approval cards */}
      {pending.length > 0 ? (
        pending.map((approval) => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            onResolve={handleResolve}
            resolving={resolving}
          />
        ))
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            paddingTop: 120,
            color: '#6b7280',
          }}
        >
          <svg width="48" height="48" viewBox="0 0 256 256" fill="currentColor" style={{ marginBottom: 16, opacity: 0.4 }}>
            <path d="M172.24,99.76a4,4,0,0,1,0,5.66l-56,56a4,4,0,0,1-5.66,0l-24-24a4,4,0,0,1,5.66-5.66L113.48,153l53.17-53.17A4,4,0,0,1,172.24,99.76ZM228,128A100,100,0,1,1,128,28,100.11,100.11,0,0,1,228,128Zm-8,0a92,92,0,1,0-92,92A92.1,92.1,0,0,0,220,128Z" />
          </svg>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>All clear</div>
          <div style={{ fontSize: 13 }}>No pending approvals</div>
          <div style={{ fontSize: 12, marginTop: 16, opacity: 0.5 }}>
            Checking every {POLL_INTERVAL / 1000}s
          </div>
        </div>
      )}

      {/* Footer */}
      <div
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 8px)',
          paddingTop: 8,
          textAlign: 'center',
          fontSize: 11,
          color: '#4b5563',
          backgroundColor: '#111111',
        } as React.CSSProperties}
      >
        Last checked {new Date(lastRefresh).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
      </div>
    </div>
  );
}
