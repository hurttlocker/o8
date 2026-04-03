'use client';

import {
  IconCheck,
  MobilePalette,
  RISK_COLORS,
  type ApprovalItem,
  isGovernanceApproval,
  mobileCardStyle,
  mobileFontFamily,
  timeAgo,
} from './mobile-approvals-shared';

function RiskBadge({ risk }: { risk: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '3px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: '#ffffff',
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
  palette,
}: {
  approval: ApprovalItem;
  onResolve: (id: string, action: 'approve' | 'reject') => void;
  resolving: string | null;
  palette: MobilePalette;
}) {
  const isResolving = resolving === approval.id;
  const agent = approval.metadata?.agent ?? approval.sessionKey?.split(':').pop() ?? 'agent';

  return (
    <div
      style={{
        ...mobileCardStyle(palette, {
          padding: 18,
          marginBottom: 12,
          background: palette.panelElevated,
        }),
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <RiskBadge risk={approval.risk} />
        <span style={{ fontSize: 12, color: palette.subduedText }}>{timeAgo(approval.createdAt)}</span>
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: palette.rootText, marginBottom: 5, lineHeight: 1.35 }}>
        {approval.title}
      </div>
      {approval.toolName ? (
        <div style={{ fontSize: 12, color: palette.subduedText, marginBottom: 4, fontFamily: 'SF Mono, Menlo, monospace' }}>
          {approval.toolName}
        </div>
      ) : null}
      <div style={{ fontSize: 13, color: palette.mutedText, marginBottom: 4 }}>{agent}</div>
      {approval.summary ? (
        <div style={{ fontSize: 13, color: palette.subduedText, marginBottom: 14, lineHeight: 1.55 }}>
          {approval.summary.length > 200 ? `${approval.summary.slice(0, 200)}...` : approval.summary}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 10 }}>
        <button
          onClick={() => onResolve(approval.id, 'approve')}
          disabled={isResolving}
          style={{
            flex: 1,
            height: 46,
            borderRadius: 999,
            border: `1px solid ${palette.successBorder}`,
            background: isResolving ? palette.cardBackground : `linear-gradient(135deg, ${palette.successSoft} 0%, ${palette.panelBackground} 100%)`,
            color: palette.rootText,
            fontSize: 15,
            fontWeight: 700,
            cursor: isResolving ? 'default' : 'pointer',
            opacity: isResolving ? 0.55 : 1,
            fontFamily: mobileFontFamily(),
          }}
        >
          {isResolving ? 'Approving...' : 'Approve'}
        </button>
        <button
          onClick={() => onResolve(approval.id, 'reject')}
          disabled={isResolving}
          style={{
            flex: 1,
            height: 46,
            borderRadius: 999,
            border: `1px solid ${palette.dangerBorder}`,
            background: isResolving ? palette.cardBackground : `linear-gradient(135deg, ${palette.dangerSoft} 0%, ${palette.panelBackground} 100%)`,
            color: palette.rootText,
            fontSize: 15,
            fontWeight: 700,
            cursor: isResolving ? 'default' : 'pointer',
            opacity: isResolving ? 0.55 : 1,
            fontFamily: mobileFontFamily(),
          }}
        >
          Reject
        </button>
      </div>
    </div>
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
  resolving: string | null;
  palette: MobilePalette;
}) {
  const pending = approvals.filter((approval) => approval.status === 'pending' && isGovernanceApproval(approval));

  return (
    <>
      <div style={{ marginBottom: 14, paddingLeft: 2 }}>
        <div style={{ fontSize: 13, color: palette.subduedText }}>
          {pending.length} pending approval{pending.length !== 1 ? 's' : ''}
        </div>
      </div>
      {pending.length > 0 ? (
        pending.map((approval) => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            onResolve={onResolve}
            resolving={resolving}
            palette={palette}
          />
        ))
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 96, color: palette.subduedText }}>
          <IconCheck fill={palette.iconFill} style={{ opacity: 0.32 }} />
          <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4, marginTop: 16, color: palette.rootText }}>
            All clear
          </div>
          <div style={{ fontSize: 13 }}>
            No pending approvals
          </div>
        </div>
      )}
    </>
  );
}
