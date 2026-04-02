'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { MobileApprovalCard } from '@/lib/approvals/types';
import { useTheme } from './ThemeContext';
import type { ApprovalStackProps } from './types';

type ApprovalResolution = 'approved' | 'rejected';
type ApprovalRiskTone = 'low' | 'medium' | 'high';

interface ResolvedApprovalEntry {
  approval: MobileApprovalCard;
  resolution: ApprovalResolution;
  resolvedAt: number;
}

const RISK_STYLES: Record<ApprovalRiskTone, { background: string; color: string }> = {
  low: {
    background: 'rgba(48,209,88,0.15)',
    color: '#30D158',
  },
  medium: {
    background: 'rgba(255,159,10,0.15)',
    color: '#FF9F0A',
  },
  high: {
    background: 'rgba(255,69,58,0.15)',
    color: '#FF453A',
  },
};

const RESOLUTION_STYLES: Record<ApprovalResolution, { background: string; color: string; label: string }> = {
  approved: {
    background: 'rgba(48,209,88,0.15)',
    color: '#30D158',
    label: 'Approved',
  },
  rejected: {
    background: 'rgba(255,69,58,0.15)',
    color: '#FF453A',
    label: 'Rejected',
  },
};

function mapSeverityToRisk(severity: MobileApprovalCard['severity']): ApprovalRiskTone {
  if (severity === 'critical') return 'high';
  if (severity === 'warning') return 'medium';
  return 'low';
}

function formatTimeAgo(timestamp: number, now: number) {
  const elapsedMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (elapsedMinutes < 1) return 'Just now';
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}d ago`;
}

function CountBadge({ count }: { count: number }) {
  const { colors } = useTheme();

  return (
    <span
      style={{
        minWidth: 22,
        height: 22,
        padding: '0 8px',
        borderRadius: 999,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: colors.surfaceBorder,
        color: colors.text,
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {count}
    </span>
  );
}

function ApprovalCard({
  approval,
  now,
  cardBackground,
  cardBorder,
  titleColor,
  secondaryTextColor,
  descriptionColor,
  metadataLabelColor,
  metadataValueColor,
  isResolved = false,
  resolution,
  onApprove,
  onReject,
}: {
  approval: MobileApprovalCard;
  now: number;
  cardBackground: string;
  cardBorder: string;
  titleColor: string;
  secondaryTextColor: string;
  descriptionColor: string;
  metadataLabelColor: string;
  metadataValueColor: string;
  isResolved?: boolean;
  resolution?: ApprovalResolution;
  onApprove?: (approval: MobileApprovalCard) => void;
  onReject?: (approval: MobileApprovalCard) => void;
}) {
  const riskTone = mapSeverityToRisk(approval.severity);
  const riskStyle = RISK_STYLES[riskTone];
  const timeLabel = formatTimeAgo(approval.createdAt, now);
  const resolutionStyle = resolution ? RESOLUTION_STYLES[resolution] : null;

  const buttonBaseStyle: CSSProperties = {
    minHeight: 44,
    borderRadius: 12,
    border: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 14px',
    fontSize: 15,
    fontWeight: 600,
    lineHeight: 1,
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  };

  return (
    <article
      style={{
        background: cardBackground,
        borderRadius: 14,
        padding: 14,
        border: `1px solid ${cardBorder}`,
        display: 'grid',
        gap: 12,
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <h3
          style={{
            margin: 0,
            color: titleColor,
            fontSize: 15,
            fontWeight: 600,
            lineHeight: 1.35,
            letterSpacing: '-0.01em',
            flex: 1,
          }}
        >
          {approval.title}
        </h3>
        <span
          style={{
            borderRadius: 22,
            padding: '2px 10px',
            fontSize: 11,
            fontWeight: 600,
            lineHeight: 1.6,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            background: riskStyle.background,
            color: riskStyle.color,
            whiteSpace: 'nowrap',
          }}
        >
          {riskTone}
        </span>
      </div>

      <p
        style={{
          margin: 0,
          color: secondaryTextColor,
          fontSize: 13,
          lineHeight: 1.4,
        }}
      >
        {approval.agent} · {timeLabel}
      </p>

      <p
        style={{
          margin: 0,
          color: descriptionColor,
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        {approval.description}
      </p>

      {approval.metadata && Object.keys(approval.metadata).length ? (
        <div
          style={{
            display: 'grid',
            gap: 8,
            paddingTop: 12,
            borderTop: `1px solid ${cardBorder}`,
          }}
        >
          {Object.entries(approval.metadata).map(([key, value]) => (
            <div
              key={key}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto',
                gap: 12,
                alignItems: 'start',
              }}
            >
              <span
                style={{
                  color: metadataLabelColor,
                  fontSize: 12,
                  fontWeight: 500,
                  lineHeight: 1.4,
                }}
              >
                {key}
              </span>
              <span
                style={{
                  color: metadataValueColor,
                  fontSize: 12,
                  fontWeight: 500,
                  lineHeight: 1.4,
                  textAlign: 'right',
                  overflowWrap: 'anywhere',
                }}
              >
                {value}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {isResolved && resolutionStyle ? (
        <div
          style={{
            minHeight: 44,
            borderRadius: 12,
            padding: '0 14px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            background: resolutionStyle.background,
            color: resolutionStyle.color,
            fontSize: 14,
            fontWeight: 600,
            lineHeight: 1,
          }}
        >
          <span aria-hidden="true">{resolution === 'approved' ? '✓' : '✕'}</span>
          <span>{resolutionStyle.label}</span>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <button
            type="button"
            style={{
              ...buttonBaseStyle,
              background: '#FF453A',
              color: '#FFFFFF',
            }}
            onClick={() => onReject?.(approval)}
          >
            {approval.actions.reject.label}
          </button>
          <button
            type="button"
            style={{
              ...buttonBaseStyle,
              background: '#30D158',
              color: '#FFFFFF',
            }}
            onClick={() => onApprove?.(approval)}
          >
            {approval.actions.approve.label}
          </button>
        </div>
      )}
    </article>
  );
}

export function ApprovalStack({
  pendingApprovals,
  resolvedApprovals,
  onApprove,
  onReject,
}: ApprovalStackProps) {
  const { colors } = useTheme();
  const [now, setNow] = useState(() => Date.now());
  const [resolvedExpanded, setResolvedExpanded] = useState(false);
  const [resolvedArchive, setResolvedArchive] = useState<Record<string, ResolvedApprovalEntry>>({});

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 60_000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    setResolvedArchive((current) => {
      const activePendingIds = new Set(pendingApprovals.map((approval) => approval.id));
      const nextEntries = { ...current };
      let changed = false;

      for (const approval of pendingApprovals) {
        const resolution = resolvedApprovals[approval.id];
        if (!resolution) continue;
        const existing = nextEntries[approval.id];
        if (!existing || existing.resolution !== resolution || existing.approval !== approval) {
          nextEntries[approval.id] = {
            approval,
            resolution,
            resolvedAt: existing?.resolvedAt ?? Date.now(),
          };
          changed = true;
        }
      }

      for (const [approvalId, entry] of Object.entries(nextEntries)) {
        if (activePendingIds.has(approvalId) && !resolvedApprovals[approvalId]) {
          delete nextEntries[approvalId];
          changed = true;
          continue;
        }

        if (!entry.approval) {
          delete nextEntries[approvalId];
          changed = true;
        }
      }

      const limitedEntries = Object.entries(nextEntries)
        .sort(([, left], [, right]) => right.resolvedAt - left.resolvedAt)
        .slice(0, 8);
      const trimmed = Object.fromEntries(limitedEntries);

      if (!changed && limitedEntries.length === Object.keys(current).length) {
        return current;
      }

      return trimmed;
    });
  }, [pendingApprovals, resolvedApprovals]);

  const pendingItems = useMemo(
    () => [...pendingApprovals]
      .filter((approval) => !resolvedApprovals[approval.id])
      .sort((left, right) => right.createdAt - left.createdAt),
    [pendingApprovals, resolvedApprovals],
  );

  const resolvedItems = useMemo(
    () => Object.values(resolvedArchive).sort((left, right) => right.resolvedAt - left.resolvedAt),
    [resolvedArchive],
  );

  if (!pendingItems.length && !resolvedItems.length) {
    return null;
  }

  const backgroundColor = colors.bg;
  const cardBackground = colors.cardBg;
  const cardBorder = colors.cardBorder;
  const titleColor = colors.text;
  const secondaryTextColor = colors.textSecondary;
  const descriptionColor = colors.text;
  const metadataLabelColor = colors.textSecondary;
  const metadataValueColor = colors.text;
  const headerLabelStyle: CSSProperties = {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    lineHeight: 1,
  };

  return (
    <section
      aria-label="Approval inbox"
      style={{
        background: backgroundColor,
        padding: '12px 14px 6px',
        display: 'grid',
        gap: 16,
      }}
    >
      {pendingItems.length ? (
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 24 }}>
            <span style={headerLabelStyle}>Pending</span>
            <CountBadge count={pendingItems.length} />
          </div>
          <div style={{ display: 'grid', gap: 10 }}>
            {pendingItems.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                now={now}
                cardBackground={cardBackground}
                cardBorder={cardBorder}
                titleColor={titleColor}
                secondaryTextColor={secondaryTextColor}
                descriptionColor={descriptionColor}
                metadataLabelColor={metadataLabelColor}
                metadataValueColor={metadataValueColor}
                onApprove={onApprove}
                onReject={onReject}
              />
            ))}
          </div>
        </div>
      ) : null}

      {resolvedItems.length ? (
        <div style={{ display: 'grid', gap: resolvedExpanded ? 10 : 0 }}>
          <button
            type="button"
            aria-expanded={resolvedExpanded}
            onClick={() => setResolvedExpanded((current) => !current)}
            style={{
              minHeight: 44,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: titleColor,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              <span style={headerLabelStyle}>Resolved</span>
              <CountBadge count={resolvedItems.length} />
            </span>
            <span
              aria-hidden="true"
              style={{
                color: secondaryTextColor,
                fontSize: 16,
                lineHeight: 1,
                transform: resolvedExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 180ms ease',
              }}
            >
              ˅
            </span>
          </button>
          {resolvedExpanded ? (
            <div style={{ display: 'grid', gap: 10 }}>
              {resolvedItems.map(({ approval, resolution }) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  now={now}
                  cardBackground={cardBackground}
                  cardBorder={cardBorder}
                  titleColor={titleColor}
                  secondaryTextColor={secondaryTextColor}
                  descriptionColor={descriptionColor}
                  metadataLabelColor={metadataLabelColor}
                  metadataValueColor={metadataValueColor}
                  isResolved
                  resolution={resolution}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
