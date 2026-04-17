'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ApprovalRecord } from '@/lib/approvals/types';

// First-class approval surface. Lives directly under TitleBar so merge-gate
// cards can't get buried in an alerts popover. Rendered only when there are
// pending approvals — zero footprint when the queue is empty.
//
// Design language: o8 desktop spec (DESIGN.md). Single orange LED accent,
// paper card surface over vibrancy chrome, mono bracketed micro-label,
// Plus Jakarta Sans body, hairline reject + solid-orange approve.

const ACCENT_ORANGE = '#FF5A1F';

const bannerShell: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  width: '100%',
  background: 'var(--t-bg-card)',
  borderBottom: '1px solid var(--t-border)',
};

const cardRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  paddingTop: 11,
  paddingBottom: 11,
  paddingLeft: 20,
  paddingRight: 14,
  borderLeftWidth: 3,
  borderLeftStyle: 'solid',
  borderLeftColor: ACCENT_ORANGE,
  background: 'var(--t-panel)',
};

const ledDot: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: 999,
  backgroundColor: ACCENT_ORANGE,
  flexShrink: 0,
};

const body: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
  flex: 1,
};

const eyebrow: CSSProperties = {
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--t-text-muted)',
  fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const titleLine: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--t-text)',
  letterSpacing: '-0.01em',
  fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const summaryLine: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 400,
  color: 'var(--t-text-muted)',
  letterSpacing: '-0.005em',
  fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const buttonBase: CSSProperties = {
  paddingTop: 8,
  paddingBottom: 8,
  paddingLeft: 16,
  paddingRight: 16,
  borderRadius: 8,
  borderWidth: 1,
  borderStyle: 'solid',
  fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
  fontSize: 12.5,
  fontWeight: 500,
  letterSpacing: '-0.005em',
  flexShrink: 0,
  lineHeight: 1,
  transition: 'background 160ms ease, border-color 160ms ease, color 160ms ease, opacity 160ms ease',
};

const rejectButton: CSSProperties = {
  ...buttonBase,
  borderColor: 'var(--t-border)',
  background: 'transparent',
  color: 'var(--t-text-muted)',
};

const approveButton: CSSProperties = {
  ...buttonBase,
  borderColor: ACCENT_ORANGE,
  background: ACCENT_ORANGE,
  color: '#FFFFFF',
};

function formatEyebrow(approval: ApprovalRecord): string {
  const riskTag = approval.risk === 'high'
    ? 'HIGH RISK'
    : approval.risk === 'medium'
      ? 'MEDIUM RISK'
      : 'APPROVAL';
  const toolTag = approval.toolName ? ` · ${approval.toolName}` : '';
  const policyTag = approval.policyRuleId ? ` · ${approval.policyRuleId.replace(/_/g, ' ')}` : '';
  return `(${riskTag})${toolTag}${policyTag}`;
}

export function ApprovalBanner() {
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/panel/approvals?status=pending', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { approvals?: ApprovalRecord[] };
      setApprovals(data.approvals ?? []);
    } catch {
      // Silent — banner hides itself when the queue is empty so a dropped
      // poll just means "no new data this tick".
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [load]);

  const resolve = useCallback(
    async (id: string, action: 'approve' | 'reject') => {
      setPendingId(id);
      try {
        await fetch('/api/panel/approvals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, id }),
        });
        await load();
      } finally {
        setPendingId(null);
      }
    },
    [load],
  );

  if (approvals.length === 0) return null;

  return (
    <div style={bannerShell} data-approval-banner="">
      {approvals.map((approval) => {
        const isPending = pendingId === approval.id;
        return (
          <div key={approval.id} style={cardRow} data-approval-id={approval.id}>
            <span style={ledDot} aria-hidden="true" />
            <div style={body}>
              <span style={eyebrow}>{formatEyebrow(approval)}</span>
              <span style={titleLine}>{approval.title}</span>
              {approval.summary && approval.summary !== approval.title ? (
                <span style={summaryLine}>{approval.summary}</span>
              ) : null}
            </div>
            <button
              type="button"
              disabled={isPending}
              onClick={() => resolve(approval.id, 'reject')}
              style={{
                ...rejectButton,
                opacity: isPending ? 0.55 : 1,
                cursor: isPending ? 'wait' : 'pointer',
              }}
            >
              Reject
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => resolve(approval.id, 'approve')}
              style={{
                ...approveButton,
                opacity: isPending ? 0.65 : 1,
                cursor: isPending ? 'wait' : 'pointer',
              }}
            >
              {isPending ? 'Resolving' : 'Approve'}
            </button>
          </div>
        );
      })}
    </div>
  );
}
