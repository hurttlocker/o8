'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ApprovalRecord } from '@/lib/approvals/types';

// First-class approval surface. Lives directly under TitleBar so merge-gate
// cards can't get buried in an alerts popover. Rendered only when there are
// pending approvals — zero footprint when the queue is empty.
//
// Design language: o8 desktop spec (DESIGN.md). Rams discipline — a single
// compressed status line when collapsed (≤28px tall), expanded on demand to
// reveal the full list with per-row Approve / Reject. One orange LED for the
// whole banner, not one per row.

const ACCENT_ORANGE = '#FF5A1F';

const bannerShell: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  background: 'var(--t-bg-card)',
  borderBottomWidth: 1,
  borderBottomStyle: 'solid',
  borderBottomColor: 'var(--t-border)',
  fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
};

const summaryBar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  height: 28,
  paddingLeft: 14,
  paddingRight: 10,
  background: 'var(--t-panel)',
};

const ledDot: CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: 999,
  backgroundColor: ACCENT_ORANGE,
  flexShrink: 0,
};

const summaryCount: CSSProperties = {
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--t-text-muted)',
  fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
  flexShrink: 0,
};

const summaryLead: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 400,
  color: 'var(--t-text)',
  letterSpacing: '-0.005em',
  flex: 1,
  minWidth: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const ghostButton: CSSProperties = {
  height: 20,
  paddingLeft: 8,
  paddingRight: 8,
  borderRadius: 5,
  borderWidth: 0,
  background: 'transparent',
  color: 'var(--t-text-muted)',
  fontSize: 10.5,
  fontWeight: 500,
  letterSpacing: '0.02em',
  cursor: 'pointer',
  flexShrink: 0,
  fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
  lineHeight: 1,
};

const compactReject: CSSProperties = {
  height: 22,
  paddingLeft: 10,
  paddingRight: 10,
  borderRadius: 6,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-border)',
  background: 'transparent',
  color: 'var(--t-text-muted)',
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: '-0.005em',
  cursor: 'pointer',
  flexShrink: 0,
  fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
  lineHeight: 1,
};

const compactApprove: CSSProperties = {
  ...compactReject,
  borderColor: ACCENT_ORANGE,
  background: ACCENT_ORANGE,
  color: '#FFFFFF',
};

const listPane: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  maxHeight: 260,
  overflowY: 'auto',
  borderTopWidth: 1,
  borderTopStyle: 'solid',
  borderTopColor: 'var(--t-divider-subtle)',
};

const listRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  height: 32,
  paddingLeft: 14,
  paddingRight: 10,
  borderBottomWidth: 1,
  borderBottomStyle: 'solid',
  borderBottomColor: 'var(--t-divider-subtle)',
};

const rowEyebrow: CSSProperties = {
  fontSize: 9.5,
  fontWeight: 500,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--t-text-faint)',
  fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
  flexShrink: 0,
};

const rowTitle: CSSProperties = {
  fontSize: 12,
  fontWeight: 400,
  color: 'var(--t-text)',
  letterSpacing: '-0.005em',
  flex: 1,
  minWidth: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

function eyebrowLabel(approval: ApprovalRecord): string {
  const risk = approval.risk === 'high' ? 'HIGH' : approval.risk === 'medium' ? 'MED' : 'LOW';
  const tool = approval.toolName ? ` · ${approval.toolName}` : '';
  return `(${risk})${tool}`;
}

export function ApprovalBanner() {
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/panel/approvals?status=pending', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { approvals?: ApprovalRecord[] };
      setApprovals(data.approvals ?? []);
    } catch {
      // silent — poll ticks again in 3s
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

  const leading = approvals[0]!;
  const leadingBusy = pendingId === leading.id;
  const extraCount = approvals.length - 1;

  return (
    <div style={bannerShell} data-approval-banner="">
      <div style={summaryBar}>
        <span style={ledDot} aria-hidden="true" />
        <span style={summaryCount}>
          {approvals.length} PENDING
        </span>
        <span style={summaryLead}>
          {leading.title}
          {extraCount > 0 ? ` · +${extraCount} more` : ''}
        </span>
        {approvals.length > 1 ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            style={ghostButton}
          >
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        ) : null}
        <button
          type="button"
          disabled={leadingBusy}
          onClick={() => resolve(leading.id, 'reject')}
          style={{ ...compactReject, opacity: leadingBusy ? 0.55 : 1, cursor: leadingBusy ? 'wait' : 'pointer' }}
        >
          Reject
        </button>
        <button
          type="button"
          disabled={leadingBusy}
          onClick={() => resolve(leading.id, 'approve')}
          style={{ ...compactApprove, opacity: leadingBusy ? 0.7 : 1, cursor: leadingBusy ? 'wait' : 'pointer' }}
        >
          {leadingBusy ? '…' : 'Approve'}
        </button>
      </div>

      {expanded && approvals.length > 1 ? (
        <div style={listPane}>
          {approvals.slice(1).map((approval) => {
            const isBusy = pendingId === approval.id;
            return (
              <div key={approval.id} style={listRow} data-approval-id={approval.id}>
                <span style={rowEyebrow}>{eyebrowLabel(approval)}</span>
                <span style={rowTitle}>{approval.title}</span>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => resolve(approval.id, 'reject')}
                  style={{ ...compactReject, opacity: isBusy ? 0.55 : 1, cursor: isBusy ? 'wait' : 'pointer' }}
                >
                  Reject
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => resolve(approval.id, 'approve')}
                  style={{ ...compactApprove, opacity: isBusy ? 0.7 : 1, cursor: isBusy ? 'wait' : 'pointer' }}
                >
                  {isBusy ? '…' : 'Approve'}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
