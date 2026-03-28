import type { PendingApproval } from './types';

export function ThoughtsApprovals({
  approvals,
  resolvingId,
  onResolve,
}: {
  approvals: PendingApproval[];
  resolvingId: string | null;
  onResolve: (id: string, action: 'approve' | 'reject') => void;
}) {
  if (approvals.length === 0) return null;

  return (
    <div style={{
      padding: '8px 12px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      borderBottom: '1px solid var(--t-divider)',
      flexShrink: 0,
      maxHeight: 200,
      overflowY: 'auto',
    }}>
      {approvals.map((approval) => (
        <div key={approval.id} style={{
          padding: '10px 12px',
          borderRadius: 14,
          background: approval.risk === 'high'
            ? 'rgba(239, 68, 68, 0.06)'
            : approval.risk === 'medium'
              ? 'rgba(245, 158, 11, 0.06)'
              : 'rgba(37, 99, 235, 0.06)',
          border: `1px solid ${
            approval.risk === 'high'
              ? 'rgba(239, 68, 68, 0.15)'
              : approval.risk === 'medium'
                ? 'rgba(245, 158, 11, 0.15)'
                : 'rgba(37, 99, 235, 0.12)'
          }`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={
              approval.risk === 'high' ? '#ef4444' : approval.risk === 'medium' ? '#f59e0b' : '#2563eb'
            } strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            <span style={{
              fontSize: 11, fontWeight: 700, color: 'var(--t-text)',
              letterSpacing: '-0.01em', flex: 1,
            }}>
              {approval.agent} — {approval.title}
            </span>
            <span style={{
              fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
              padding: '2px 6px', borderRadius: 5,
              background: approval.risk === 'high'
                ? 'rgba(239, 68, 68, 0.1)'
                : approval.risk === 'medium'
                  ? 'rgba(245, 158, 11, 0.1)'
                  : 'rgba(37, 99, 235, 0.1)',
              color: approval.risk === 'high'
                ? '#ef4444'
                : approval.risk === 'medium'
                  ? '#f59e0b'
                  : '#2563eb',
              letterSpacing: '0.03em',
            }}>
              {approval.risk}
            </span>
          </div>
          <div style={{
            fontSize: 11, color: 'var(--t-text-secondary)', lineHeight: 1.5,
            marginBottom: approval.command ? 6 : 8,
          }}>
            {approval.description}
          </div>
          {approval.command && (
            <div style={{
              padding: '6px 8px', borderRadius: 8,
              background: 'var(--t-code-bg)',
              fontFamily: 'SF Mono, Menlo, monospace',
              fontSize: 10, color: 'var(--t-text)',
              marginBottom: 8, whiteSpace: 'pre-wrap',
              wordBreak: 'break-all', lineHeight: 1.4,
            }}>
              $ {approval.command}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              onClick={() => onResolve(approval.id, 'approve')}
              disabled={resolvingId === approval.id}
              style={{
                flex: 1, padding: '7px 0', borderRadius: 10, border: 'none',
                background: '#22c55e', color: '#fff',
                fontSize: 11, fontWeight: 700, cursor: 'pointer',
                opacity: resolvingId === approval.id ? 0.5 : 1,
                letterSpacing: '-0.01em',
              }}
            >
              {resolvingId === approval.id ? 'Resolving...' : 'Approve'}
            </button>
            <button
              type="button"
              onClick={() => onResolve(approval.id, 'reject')}
              disabled={resolvingId === approval.id}
              style={{
                flex: 1, padding: '7px 0', borderRadius: 10,
                border: '1px solid rgba(239, 68, 68, 0.2)',
                background: 'rgba(239, 68, 68, 0.06)',
                color: '#ef4444',
                fontSize: 11, fontWeight: 700, cursor: 'pointer',
                opacity: resolvingId === approval.id ? 0.5 : 1,
                letterSpacing: '-0.01em',
              }}
            >
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
