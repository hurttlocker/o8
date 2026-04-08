'use client';

import { useState } from 'react';
import {
  IconCheck,
  MOBILE_BODY_TRACKING,
  MOBILE_CARD_RADIUS,
  MOBILE_HEADING_TRACKING,
  RISK_COLORS,
  type ApprovalItem,
  type MobilePalette,
  timeAgo,
} from './mobile-approvals-shared';
import {
  MobileGlassPanel,
  MobilePillButton,
  MobileSectionHeading,
  MobileSurfaceRoot,
  MobileThreadListRoot,
  mobileSafeBottom,
} from './mobile-shell-primitives';

function RiskBadge({ risk }: { risk: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 26,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 999,
        backgroundColor: RISK_COLORS[risk] ?? RISK_COLORS.low,
        color: '#ffffff',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      }}
    >
      {risk}
    </span>
  );
}

// ── Gate Report (collapsible) ──

const GATE_LABELS: Record<string, string> = { security: 'Security', budget: 'Budget', integrity: 'Integrity' };

function MobileGateReport({ approval, palette }: { approval: ApprovalItem; palette: MobilePalette }) {
  const gate = approval.gateResult;
  if (!gate || gate.violations.length === 0) return null;

  const [open, setOpen] = useState(false);
  const blocks = gate.violations.filter((v) => v.severity === 'block').length;
  const warns = gate.violations.filter((v) => v.severity === 'warn').length;

  return (
    <div style={{ marginBottom: 10 }}>
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '8px 12px',
          borderRadius: MOBILE_CARD_RADIUS,
          border: `1px solid ${palette.dangerBorder}`,
          background: palette.dangerSoft,
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 700,
          color: palette.danger,
          letterSpacing: MOBILE_BODY_TRACKING,
        }}
      >
        <span style={{
          display: 'inline-block',
          width: 12,
          textAlign: 'center',
          transition: 'transform 150ms ease',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        }}>
          {'\u25B6'}
        </span>
        Gate: {blocks} block{blocks !== 1 ? 's' : ''}, {warns} warn{warns !== 1 ? 's' : ''}
      </button>

      {open ? (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(['security', 'budget', 'integrity'] as const).map((cat) => {
            const vs = gate.violations.filter((v) => v.category === cat);
            return (
              <div key={cat} style={{ padding: '4px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 2 }}>
                  <span style={{ color: vs.length === 0 ? '#16a34a' : palette.danger, fontWeight: 800 }}>
                    {vs.length === 0 ? '\u2713' : '\u2717'}
                  </span>
                  <span style={{ fontWeight: 700, color: palette.rootText }}>{GATE_LABELS[cat]}</span>
                  {vs.length === 0 ? (
                    <span style={{ color: palette.subduedText, fontWeight: 600 }}>passed</span>
                  ) : (
                    <span style={{ color: palette.danger, fontWeight: 600 }}>{vs.length}</span>
                  )}
                </div>
                {vs.map((v, i) => (
                  <div key={i} style={{
                    fontSize: 11,
                    lineHeight: 1.4,
                    color: palette.mutedText,
                    paddingLeft: 20,
                    marginTop: 1,
                  }}>
                    {v.label}{v.file ? ` (${v.file})` : ''}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ── Conflict Section with strategy picker ──

const STRATEGIES = [
  { value: 'theirs', label: 'Theirs', desc: 'Keep branch' },
  { value: 'ours', label: 'Ours', desc: 'Keep base' },
  { value: 'manual', label: 'Manual', desc: 'Fix in terminal' },
] as const;

function MobileConflictSection({
  approval,
  onResolve,
  resolving,
  palette,
}: {
  approval: ApprovalItem;
  onResolve: (id: string, action: 'approve' | 'reject', strategy?: string) => void;
  resolving: { id: string; action: 'approve' | 'reject' } | null;
  palette: MobilePalette;
}) {
  const conflict = approval.conflictReport;
  if (!conflict || conflict.files.length === 0) return null;

  const [strategy, setStrategy] = useState<string>('theirs');
  const isBusy = resolving?.id === approval.id;

  return (
    <div>
      <div style={{
        padding: '10px 12px',
        borderRadius: MOBILE_CARD_RADIUS,
        background: 'rgba(245, 158, 11, 0.06)',
        border: '1px solid rgba(245, 158, 11, 0.14)',
        marginBottom: 8,
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#b45309', marginBottom: 4, letterSpacing: MOBILE_BODY_TRACKING }}>
          {conflict.files.length} conflicting file{conflict.files.length !== 1 ? 's' : ''}
        </div>
        {conflict.files.slice(0, 6).map((file) => (
          <div key={file} style={{
            fontSize: 11,
            fontFamily: 'SF Mono, Menlo, monospace',
            color: palette.mutedText,
            lineHeight: 1.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {file}
          </div>
        ))}
        {conflict.files.length > 6 ? (
          <div style={{ fontSize: 11, color: palette.subduedText, marginTop: 2 }}>
            +{conflict.files.length - 6} more
          </div>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {STRATEGIES.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setStrategy(opt.value)}
            style={{
              flex: 1,
              padding: '8px 4px',
              borderRadius: MOBILE_CARD_RADIUS,
              border: strategy === opt.value
                ? '1.5px solid rgba(37, 99, 235, 0.35)'
                : `1px solid ${palette.cardBorder}`,
              background: strategy === opt.value
                ? 'rgba(37, 99, 235, 0.08)'
                : 'transparent',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 700,
              color: strategy === opt.value ? '#2563eb' : palette.mutedText,
              textAlign: 'center',
              lineHeight: 1.3,
            }}
          >
            {opt.label}
            <div style={{ fontSize: 9, fontWeight: 600, marginTop: 2, opacity: 0.7 }}>
              {opt.desc}
            </div>
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
        <MobilePillButton
          onClick={() => onResolve(approval.id, 'approve', strategy)}
          palette={palette}
          tone="success"
          disabled={isBusy}
          style={{ minHeight: 40, fontSize: 13, fontWeight: 700 }}
        >
          {isBusy && resolving?.action === 'approve' ? '...' : `Merge (${STRATEGIES.find((s) => s.value === strategy)?.label})`}
        </MobilePillButton>
        <MobilePillButton
          onClick={() => onResolve(approval.id, 'reject')}
          palette={palette}
          tone="danger"
          disabled={isBusy}
          style={{ minHeight: 40, paddingLeft: 16, paddingRight: 16, fontSize: 13, fontWeight: 700 }}
        >
          {isBusy && resolving?.action === 'reject' ? '...' : 'Reject'}
        </MobilePillButton>
      </div>
    </div>
  );
}

// ── Standard Approval Card ──

function ApprovalCard({
  approval,
  onResolve,
  resolving,
  palette,
}: {
  approval: ApprovalItem;
  onResolve: (id: string, action: 'approve' | 'reject', strategy?: string) => void;
  resolving: { id: string; action: 'approve' | 'reject' } | null;
  palette: MobilePalette;
}) {
  const isApproving = resolving?.id === approval.id && resolving.action === 'approve';
  const isRejecting = resolving?.id === approval.id && resolving.action === 'reject';
  const isBusy = resolving?.id === approval.id;
  const agent = approval.metadata?.agent ?? approval.sessionKey?.split(':').pop() ?? 'operator';
  const hasConflict = approval.conflictReport && approval.conflictReport.files.length > 0;

  return (
    <MobileGlassPanel palette={palette} style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <RiskBadge risk={approval.risk} />
          {approval.toolName ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                minHeight: 26,
                paddingLeft: 10,
                paddingRight: 10,
                borderRadius: 999,
                background: palette.cardBackground,
                border: `1px solid ${palette.cardBorder}`,
                fontSize: 11,
                fontWeight: 700,
                color: palette.subduedText,
                fontFamily: 'SF Mono, Menlo, monospace',
              }}
            >
              {approval.toolName}
            </span>
          ) : null}
        </div>
        <span style={{ fontSize: 12, color: palette.subduedText, flexShrink: 0 }}>
          {timeAgo(approval.createdAt)}
        </span>
      </div>

      <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.3, letterSpacing: MOBILE_HEADING_TRACKING, color: palette.rootText, marginBottom: 4 }}>
        {approval.title}
      </div>

      <div style={{ fontSize: 13, lineHeight: 1.55, letterSpacing: MOBILE_BODY_TRACKING, color: palette.mutedText, marginBottom: 10 }}>
        {approval.description || approval.summary || 'Approval required.'}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 11, color: palette.subduedText }}>
        <span style={{ fontWeight: 600 }}>{agent}</span>
        {approval.sessionKey ? (
          <>
            <span style={{ opacity: 0.4 }}>/</span>
            <span style={{ fontFamily: 'SF Mono, Menlo, monospace', fontSize: 10 }}>{approval.sessionKey.split(':').pop()?.slice(0, 12)}</span>
          </>
        ) : null}
      </div>

      <MobileGateReport approval={approval} palette={palette} />

      {hasConflict ? (
        <MobileConflictSection approval={approval} onResolve={onResolve} resolving={resolving} palette={palette} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <MobilePillButton
            onClick={() => onResolve(approval.id, 'approve')}
            palette={palette}
            tone="success"
            disabled={isBusy}
            style={{ minHeight: 40, fontSize: 13, fontWeight: 700 }}
          >
            {isApproving ? '...' : 'Approve'}
          </MobilePillButton>
          <MobilePillButton
            onClick={() => onResolve(approval.id, 'reject')}
            palette={palette}
            tone="danger"
            disabled={isBusy}
            style={{ minHeight: 40, fontSize: 13, fontWeight: 700 }}
          >
            {isRejecting ? '...' : 'Reject'}
          </MobilePillButton>
        </div>
      )}
    </MobileGlassPanel>
  );
}

// ── Main View ──

export function ApprovalsView({
  approvals,
  onResolve,
  resolving,
  palette,
}: {
  approvals: ApprovalItem[];
  onResolve: (id: string, action: 'approve' | 'reject', strategy?: string) => void;
  resolving: { id: string; action: 'approve' | 'reject' } | null;
  palette: MobilePalette;
}) {
  const pending = approvals.filter((approval) => {
    if (approval.status !== 'pending') return false;
    // Hide Claude Code runtime approvals — user runs with bypass permissions
    if (approval.source === 'runtime') return false;
    if (approval.continuation?.kind === 'runtime') return false;
    // Hide LLM chat approvals (low-risk, auto-resolved)
    if (approval.source === 'llm-chat' && approval.risk === 'low') return false;
    return true;
  });

  return (
    <MobileSurfaceRoot>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          paddingBottom: mobileSafeBottom(24),
        }}
      >
        <MobileGlassPanel palette={palette} style={{ padding: 20, marginBottom: 14 }}>
          <MobileSectionHeading
            eyebrow="Approvals Queue"
            title={pending.length > 0 ? `${pending.length} pending` : 'Queue clear'}
            subtitle={pending.length > 0
              ? 'Review the request, then approve or reject it from the same surface.'
              : 'New approval requests will appear here as they arrive.'}
            palette={palette}
          />
        </MobileGlassPanel>

        {pending.length > 0 ? (
          <MobileThreadListRoot>
            {pending.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                onResolve={onResolve}
                resolving={resolving}
                palette={palette}
              />
            ))}
          </MobileThreadListRoot>
        ) : (
          <MobileGlassPanel
            palette={palette}
            style={{
              padding: '44px 20px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
            }}
          >
            <IconCheck fill={palette.iconFill} style={{ opacity: 0.34 }} />
            <div style={{ fontSize: 20, fontWeight: 800, color: palette.rootText, letterSpacing: MOBILE_HEADING_TRACKING, marginTop: 16, marginBottom: 6 }}>
              All clear
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.7, letterSpacing: MOBILE_BODY_TRACKING, color: palette.subduedText, maxWidth: 260 }}>
              There are no pending approvals right now. This page will refresh as new requests land.
            </div>
          </MobileGlassPanel>
        )}
      </div>
    </MobileSurfaceRoot>
  );
}
