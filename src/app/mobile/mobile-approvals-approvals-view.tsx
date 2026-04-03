'use client';

import {
  IconCheck,
  RISK_COLORS,
  type ApprovalItem,
  type MobilePalette,
  timeAgo,
} from './mobile-approvals-shared';
import {
  MobileGlassPanel,
  MobileMetricChip,
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

function ApprovalCard({
  approval,
  onResolve,
  resolving,
  palette,
}: {
  approval: ApprovalItem;
  onResolve: (id: string, action: 'approve' | 'reject') => void;
  resolving: { id: string; action: 'approve' | 'reject' } | null;
  palette: MobilePalette;
}) {
  const isApproving = resolving?.id === approval.id && resolving.action === 'approve';
  const isRejecting = resolving?.id === approval.id && resolving.action === 'reject';
  const isBusy = resolving?.id === approval.id;
  const agent = approval.metadata?.agent ?? approval.sessionKey?.split(':').pop() ?? 'operator';

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

      <div style={{ fontSize: 19, fontWeight: 800, lineHeight: 1.2, letterSpacing: '-0.03em', color: palette.rootText, marginBottom: 8 }}>
        {approval.title}
      </div>

      <div style={{ fontSize: 14, lineHeight: 1.65, color: palette.mutedText, marginBottom: 14 }}>
        {approval.description || approval.summary || 'Approval required.'}
      </div>

      {approval.summary && approval.summary !== approval.description ? (
        <div
          style={{
            borderRadius: 18,
            border: `1px solid ${palette.cardBorder}`,
            background: palette.cardBackground,
            padding: '12px 14px',
            fontSize: 13,
            lineHeight: 1.6,
            color: palette.subduedText,
            marginBottom: 14,
          }}
        >
          {approval.summary}
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
        <MobileMetricChip label="Agent" value={agent} palette={palette} />
        <MobileMetricChip label="Session" value={approval.sessionKey || 'n/a'} palette={palette} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <MobilePillButton
          onClick={() => onResolve(approval.id, 'approve')}
          palette={palette}
          tone="success"
          disabled={isBusy}
          style={{ minHeight: 48, fontSize: 14, fontWeight: 800 }}
        >
          {isApproving ? 'Approving...' : 'Approve'}
        </MobilePillButton>
        <MobilePillButton
          onClick={() => onResolve(approval.id, 'reject')}
          palette={palette}
          tone="danger"
          disabled={isBusy}
          style={{ minHeight: 48, fontSize: 14, fontWeight: 800 }}
        >
          {isRejecting ? 'Rejecting...' : 'Reject'}
        </MobilePillButton>
      </div>
    </MobileGlassPanel>
  );
}

export function ApprovalsView({
  approvals,
  onResolve,
  resolving,
  palette,
}: {
  approvals: ApprovalItem[];
  onResolve: (id: string, action: 'approve' | 'reject') => void;
  resolving: { id: string; action: 'approve' | 'reject' } | null;
  palette: MobilePalette;
}) {
  const pending = approvals.filter((approval) => approval.status === 'pending');

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
            <div style={{ fontSize: 20, fontWeight: 800, color: palette.rootText, marginTop: 16, marginBottom: 6 }}>
              All clear
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.7, color: palette.subduedText, maxWidth: 260 }}>
              There are no pending approvals right now. This page will refresh as new requests land.
            </div>
          </MobileGlassPanel>
        )}
      </div>
    </MobileSurfaceRoot>
  );
}
