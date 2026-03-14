'use client';

import type { CSSProperties } from 'react';
import type { ApprovalStackProps } from './types';

export function ApprovalStack({
  pendingApprovals,
  resolvedApprovals,
  onApprove,
  onReject,
}: ApprovalStackProps) {
  if (!pendingApprovals.length) {
    return null;
  }

  return (
    <div className="remodex-approval-stack">
      {pendingApprovals.map((approval) => {
        const resolved = resolvedApprovals[approval.id];
        const severityColor = approval.severity === 'critical'
          ? '#ff3b30'
          : approval.severity === 'warning'
            ? '#ff9f0a'
            : '#007aff';
        const elapsed = Math.round((Date.now() - approval.createdAt) / 60_000);
        const timeLabel = elapsed < 1 ? 'just now' : `${elapsed}m ago`;

        const cardStyle: CSSProperties = {
          background: '#ffffff',
          borderRadius: 16,
          padding: '16px 18px',
          border: '1px solid rgba(0,0,0,0.06)',
          borderLeft: `4px solid ${severityColor}`,
          boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
        };
        const headerStyle: CSSProperties = {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
        };
        const agentDotStyle: CSSProperties = {
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: severityColor,
          display: 'inline-block',
          marginRight: 8,
        };
        const agentNameStyle: CSSProperties = {
          fontSize: 13,
          fontWeight: 600,
          color: '#86868b',
          textTransform: 'uppercase',
          letterSpacing: '0.03em',
        };
        const timeStyle: CSSProperties = {
          fontSize: 12,
          color: '#aeaeb2',
        };
        const titleStyle: CSSProperties = {
          fontSize: 17,
          fontWeight: 700,
          color: '#1d1d1f',
          margin: '0 0 6px',
          letterSpacing: '-0.02em',
          lineHeight: 1.25,
        };
        const descStyle: CSSProperties = {
          fontSize: 14,
          color: '#636366',
          margin: '0 0 12px',
          lineHeight: 1.45,
        };
        const metaWrapStyle: CSSProperties = {
          borderTop: '1px solid #f5f5f7',
          paddingTop: 10,
          marginBottom: 14,
        };
        const metaRowStyle: CSSProperties = {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          padding: '4px 0',
        };
        const metaKeyStyle: CSSProperties = { fontSize: 13, color: '#aeaeb2' };
        const metaValStyle: CSSProperties = {
          fontSize: 13,
          fontWeight: 500,
          color: '#1d1d1f',
          fontVariantNumeric: 'tabular-nums',
        };
        const actionsStyle: CSSProperties = {
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 10,
        };
        const btnBase: CSSProperties = {
          padding: '13px 0',
          borderRadius: 12,
          fontSize: 15,
          fontWeight: 600,
          border: 'none',
          textAlign: 'center',
          WebkitTapHighlightColor: 'transparent',
          cursor: 'pointer',
        };
        const rejectBtnStyle: CSSProperties = {
          ...btnBase,
          background: '#f5f5f7',
          color: '#636366',
        };
        const approveBtnStyle: CSSProperties = {
          ...btnBase,
          background: '#ef4444',
          color: '#ffffff',
          boxShadow: '0 2px 10px rgba(239,68,68,0.3)',
        };
        const resolvedBarStyle: CSSProperties = {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          padding: '12px 0',
          borderRadius: 12,
          fontSize: 15,
          fontWeight: 600,
          background: resolved === 'approved' ? 'rgba(52,199,89,0.12)' : 'rgba(255,59,48,0.08)',
          color: resolved === 'approved' ? '#34c759' : '#ff3b30',
        };

        return (
          <div
            key={approval.id}
            className={`remodex-approval-card-wrap ${resolved ? 'remodex-approval-resolved' : ''}`}
          >
            <div style={cardStyle}>
              <div style={headerStyle}>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <span style={agentDotStyle} />
                  <span style={agentNameStyle}>{approval.agent}</span>
                </div>
                <span style={timeStyle}>{timeLabel}</span>
              </div>

              <h3 style={titleStyle}>{approval.title}</h3>
              <p style={descStyle}>{approval.description}</p>

              {approval.metadata ? (
                <div style={metaWrapStyle}>
                  {Object.entries(approval.metadata).map(([key, value]) => (
                    <div key={key} style={metaRowStyle}>
                      <span style={metaKeyStyle}>{key}</span>
                      <span style={metaValStyle}>{value}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {resolved ? (
                <div style={resolvedBarStyle}>
                  <span>{resolved === 'approved' ? '✓' : '✕'}</span>
                  <span>{resolved === 'approved' ? 'Approved' : 'Rejected'}</span>
                </div>
              ) : (
                <div style={actionsStyle}>
                  <button type="button" style={rejectBtnStyle} onClick={() => onReject(approval)}>
                    {approval.actions.reject.label}
                  </button>
                  <button type="button" style={approveBtnStyle} onClick={() => onApprove(approval)}>
                    {approval.actions.approve.label}
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
