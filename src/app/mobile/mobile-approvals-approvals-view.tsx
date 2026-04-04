'use client';

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
