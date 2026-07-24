'use client';

import { memo, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { AgentSummary, EventSeverity } from '@/lib/fleet/types';
import type { MobileInboxItem, MobileInboxSnapshot } from '@/lib/mobile/types';
import { formatMobileActivityTime } from '@/lib/mobile/activity-time';
import { FONTS, usePretextTruncation } from '@/lib/pretext';
import { useTheme } from './ThemeContext';
import { PullToRefresh } from './PullToRefresh';

interface ActivityFeedProps {
  snapshot: MobileInboxSnapshot;
  onBack: () => void;
  onAgentSelect: (sessionKey: string) => void;
  onApprove: (item: MobileInboxItem) => void;
  onDeny: (item: MobileInboxItem) => void;
  onReviewPR?: (repoPath: string, prNumber: number) => void;
  onRefresh?: () => Promise<void> | void;
  hideHeader?: boolean;
}

type ActivityFilter = 'all' | 'approvals' | 'alerts' | 'agents' | 'reviews';
type ActivityTone = 'coding' | 'thinking' | 'testing' | 'error' | 'success' | 'idle';
type ThemeColors = ReturnType<typeof useTheme>['colors'];

interface ActivityPalette {
  background: string;
  cardBg: string;
  cardBorder: string;
  timelineLine: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  doneText: string;
  status: Record<ActivityTone, string>;
}

const SYSTEM_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif';
const INLINE_CODE_PATTERN = /(`[^`\n]+`)/g;

function renderInlineCodeText(text: string, codeBg: string): ReactNode {
  const parts = text.split(INLINE_CODE_PATTERN);
  if (parts.length === 1) {
    return text;
  }

  return parts.map((part, index) => {
    const isInlineCode = part.startsWith('`') && part.endsWith('`') && part.length > 1;
    if (!isInlineCode) {
      return <span key={`text-${index}`}>{part}</span>;
    }

    return (
      <code
        key={`code-${index}`}
        style={{
          font: FONTS.mono,
          fontFamily: '"SF Mono", Menlo, ui-monospace, monospace',
          fontSize: 12,
          background: codeBg,
          padding: '2px 6px',
          borderRadius: 4,
        }}
      >
        {part.slice(1, -1)}
      </code>
    );
  });
}

function buildPalette(colors: ThemeColors): ActivityPalette {
  return {
    background: colors.bg,
    cardBg: colors.activityCardBg,
    cardBorder: colors.activityCardBorder,
    timelineLine: colors.activityTimelineLine,
    textPrimary: colors.text,
    textSecondary: colors.textSecondary,
    textTertiary: colors.textTertiary,
    doneText: colors.blueAccent,
    status: {
      coding: colors.activityStatusCoding,
      thinking: colors.activityStatusThinking,
      testing: colors.activityStatusTesting,
      error: colors.activityStatusError,
      success: colors.activityStatusSuccess,
      idle: colors.activityStatusIdle,
    },
  };
}

function toneFromSeverity(severity: EventSeverity, fallback: ActivityTone): ActivityTone {
  if (severity === 'critical') return 'error';
  if (severity === 'success') return 'success';
  if (severity === 'warning') return 'testing';
  return fallback;
}

function includesKeyword(value: string, keywords: string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword));
}

function toneForAgent(agent: AgentSummary): ActivityTone {
  if (agent.status === 'failed') return 'error';
  if (agent.status === 'idle') return 'idle';

  const taskText = `${agent.currentTask ?? ''} ${agent.activity?.headline ?? ''}`.toLowerCase();
  if (includesKeyword(taskText, ['test', 'jest', 'playwright', 'cypress', 'lint', 'typecheck', 'qa', 'spec'])) {
    return 'testing';
  }
  if (agent.status === 'huddling' || agent.status === 'waiting' || agent.status === 'blocked' || agent.status === 'reviewing' || includesKeyword(taskText, ['think', 'plan', 'review'])) {
    return 'thinking';
  }

  return 'coding';
}

function labelForAgent(tone: ActivityTone): string {
  if (tone === 'testing') return 'Testing';
  if (tone === 'thinking') return 'Thinking';
  if (tone === 'error') return 'Error';
  if (tone === 'idle') return 'Idle';
  return 'Coding';
}

function toneForApproval(item: MobileInboxItem): ActivityTone {
  return toneFromSeverity(item.severity, 'testing');
}

function toneForAlert(item: MobileInboxItem): ActivityTone {
  return toneFromSeverity(item.severity, 'thinking');
}

function toneForReview(item: MobileInboxItem): ActivityTone {
  return toneFromSeverity(item.severity, 'thinking');
}

function toneForFilter(filter: ActivityFilter): ActivityTone {
  if (filter === 'approvals') return 'testing';
  if (filter === 'reviews') return 'thinking';
  if (filter === 'alerts') return 'error';
  if (filter === 'agents') return 'coding';
  return 'coding';
}

function cardStyle(palette: ActivityPalette): CSSProperties {
  return {
    width: '100%',
    padding: 12,
    borderRadius: 14,
    background: palette.cardBg,
    border: `1px solid ${palette.cardBorder}`,
    boxSizing: 'border-box',
    overflow: 'hidden',
  };
}

function headerTextStyle(palette: ActivityPalette): CSSProperties {
  return {
    margin: 0,
    fontSize: 14,
    fontWeight: 600,
    color: palette.textPrimary,
    fontFamily: SYSTEM_FONT,
    lineHeight: 1.35,
  };
}

function bodyTextStyle(palette: ActivityPalette): CSSProperties {
  return {
    margin: 0,
    fontSize: 12,
    lineHeight: 1.45,
    color: palette.textSecondary,
    fontFamily: SYSTEM_FONT,
  };
}

function timestampStyle(palette: ActivityPalette): CSSProperties {
  return {
    margin: 0,
    fontSize: 11,
    lineHeight: 1.2,
    color: palette.textTertiary,
    fontFamily: SYSTEM_FONT,
    flexShrink: 0,
  };
}

function TimelineItem({
  palette,
  tone,
  children,
}: {
  palette: ActivityPalette;
  tone: ActivityTone;
  children: ReactNode;
}) {
  return (
    <div style={{ position: 'relative', paddingLeft: 16 }}>
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 18,
          left: -6,
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: palette.status[tone],
          border: `2px solid ${palette.background}`,
          boxSizing: 'border-box',
        }}
      />
      {children}
    </div>
  );
}

function EventIcon({
  kind,
  tone,
  palette,
}: {
  kind: 'approval' | 'alert' | 'review' | 'agent';
  tone: ActivityTone;
  palette: ActivityPalette;
}) {
  const color = palette.status[tone];

  return (
    <span
      aria-hidden="true"
      style={{
        width: 28,
        height: 28,
        borderRadius: 10,
        border: `1px solid ${palette.cardBorder}`,
        background: palette.background,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        color,
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {kind === 'approval' ? (
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        ) : null}
        {kind === 'review' ? (
          <>
            <circle cx="18" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <path d="M13 6h3a2 2 0 0 1 2 2v7" />
            <path d="M6 9v12" />
          </>
        ) : null}
        {kind === 'agent' ? (
          <>
            <path d="m8 9-3 3 3 3" />
            <path d="m16 9 3 3-3 3" />
            <path d="m13 7-2 10" />
          </>
        ) : null}
        {kind === 'alert' ? (
          tone === 'success' ? (
            <>
              <circle cx="12" cy="12" r="9" />
              <path d="m8.5 12.5 2.5 2.5 4.5-5" />
            </>
          ) : (
            <>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v4" />
              <path d="M12 16h.01" />
            </>
          )
        ) : null}
      </svg>
    </span>
  );
}

function SectionHeader({
  label,
  tone,
  palette,
}: {
  label: string;
  tone: ActivityTone;
  palette: ActivityPalette;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: palette.status[tone],
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: palette.status[tone],
          fontFamily: SYSTEM_FONT,
        }}
      >
        {label}
      </span>
    </div>
  );
}

function ApprovalCard({
  item,
  onApprove,
  onDeny,
  palette,
}: {
  item: MobileInboxItem;
  onApprove: () => void;
  onDeny: () => void;
  palette: ActivityPalette;
}) {
  const tone = toneForApproval(item);
  const accent = palette.status[tone];
  const cardWidth = typeof window !== 'undefined' ? Math.max(window.innerWidth - 96, 220) : 280;
  const { truncated: detailText } = usePretextTruncation(item.detail ?? '', 'small', cardWidth, 3);

  return (
    <TimelineItem palette={palette} tone={tone}>
      <div style={cardStyle(palette)}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <EventIcon kind="approval" tone={tone} palette={palette} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ ...bodyTextStyle(palette), marginBottom: 3, color: accent, fontWeight: 600 }}>
              Approval required
            </p>
            <p style={headerTextStyle(palette)}>{item.title}</p>
          </div>
          <span style={timestampStyle(palette)}>{item.timestampLabel || ''}</span>
        </div>
        <p style={{ ...bodyTextStyle(palette), marginTop: 10 }}>
          {renderInlineCodeText(detailText, palette.cardBg)}
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button
            type="button"
            onClick={onApprove}
            style={{
              flex: 1,
              minHeight: 44,
              borderRadius: 12,
              border: `1px solid ${palette.status.success}`,
              background: palette.status.success,
              color: palette.background,
              fontSize: 13,
              fontWeight: 700,
              fontFamily: SYSTEM_FONT,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            Approve
          </button>
          <button
            type="button"
            onClick={onDeny}
            style={{
              flex: 1,
              minHeight: 44,
              borderRadius: 12,
              border: `1px solid ${palette.status.error}`,
              background: palette.cardBg,
              color: palette.status.error,
              fontSize: 13,
              fontWeight: 700,
              fontFamily: SYSTEM_FONT,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            Deny
          </button>
        </div>
      </div>
    </TimelineItem>
  );
}

function AlertCard({
  item,
  palette,
}: {
  item: MobileInboxItem;
  palette: ActivityPalette;
}) {
  const tone = toneForAlert(item);

  return (
    <TimelineItem palette={palette} tone={tone}>
      <div style={cardStyle(palette)}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <EventIcon kind="alert" tone={tone} palette={palette} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={headerTextStyle(palette)}>{item.title}</p>
            <p style={{ ...bodyTextStyle(palette), marginTop: 4 }}>
              {renderInlineCodeText(`${item.detail.slice(0, 120)}${item.detail.length > 120 ? '…' : ''}`, palette.cardBg)}
            </p>
          </div>
          <span style={timestampStyle(palette)}>{item.timestampLabel || ''}</span>
        </div>
      </div>
    </TimelineItem>
  );
}

function ReviewCard({
  item,
  palette,
  onOpen,
}: {
  item: MobileInboxItem;
  palette: ActivityPalette;
  onOpen: () => void;
}) {
  const tone = toneForReview(item);

  return (
    <TimelineItem palette={palette} tone={tone}>
      <button
        type="button"
        onClick={onOpen}
        style={{
          ...cardStyle(palette),
          minHeight: 64,
          cursor: 'pointer',
          WebkitTapHighlightColor: 'transparent',
          textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <EventIcon kind="review" tone={tone} palette={palette} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={headerTextStyle(palette)}>{item.title}</p>
            <p
              style={{
                ...bodyTextStyle(palette),
                marginTop: 4,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {renderInlineCodeText(item.detail, palette.cardBg)}
            </p>
          </div>
          <span style={timestampStyle(palette)}>{item.timestampLabel || ''}</span>
        </div>
      </button>
    </TimelineItem>
  );
}

function AgentEventCard({
  agent,
  palette,
  onSelect,
}: {
  agent: AgentSummary;
  palette: ActivityPalette;
  onSelect: () => void;
}) {
  const tone = toneForAgent(agent);
  const accent = palette.status[tone];
  const statusLabel = labelForAgent(tone);
  const contextPercent = Math.round(agent.context?.usedPercent ?? 0);

  return (
    <TimelineItem palette={palette} tone={tone}>
      <button
        type="button"
        onClick={onSelect}
        style={{
          ...cardStyle(palette),
          minHeight: 72,
          cursor: 'pointer',
          WebkitTapHighlightColor: 'transparent',
          textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <EventIcon kind="agent" tone={tone} palette={palette} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p
              style={{
                margin: 0,
                fontSize: 14,
                fontWeight: 600,
                color: palette.textPrimary,
                fontFamily: SYSTEM_FONT,
                lineHeight: 1.35,
              }}
            >
              {agent.name}
            </p>
            <p style={{ ...bodyTextStyle(palette), marginTop: 3, color: accent, fontWeight: 600 }}>
              {statusLabel} • {contextPercent}% context
            </p>
            {agent.currentTask ? (
              <p
                style={{
                  ...bodyTextStyle(palette),
                  marginTop: 6,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {renderInlineCodeText(agent.currentTask, palette.cardBg)}
              </p>
            ) : null}
          </div>
          <span style={timestampStyle(palette)}>{formatMobileActivityTime(agent.lastEventAt)}</span>
        </div>
      </button>
    </TimelineItem>
  );
}

function EmptyState({
  palette,
  title,
  detail,
}: {
  palette: ActivityPalette;
  title: string;
  detail: string;
}) {
  return (
    <div style={{ ...cardStyle(palette), padding: 20, textAlign: 'center' }}>
      <svg
        width="32"
        height="32"
        viewBox="0 0 24 24"
        fill="none"
        stroke={palette.status.coding}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ margin: '0 auto 12px', display: 'block' }}
      >
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
      <p
        style={{
          margin: 0,
          fontSize: 15,
          fontWeight: 600,
          color: palette.textPrimary,
          fontFamily: SYSTEM_FONT,
        }}
      >
        {title}
      </p>
      <p
        style={{
          margin: '6px 0 0',
          fontSize: 12,
          lineHeight: 1.45,
          color: palette.textSecondary,
          fontFamily: SYSTEM_FONT,
        }}
      >
        {detail}
      </p>
    </div>
  );
}

export const ActivityFeed = memo(function ActivityFeed({
  snapshot,
  onBack,
  onAgentSelect,
  onApprove,
  onDeny,
  onReviewPR,
  onRefresh,
  hideHeader = false,
}: ActivityFeedProps) {
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const { colors } = useTheme();

  const palette = useMemo(() => buildPalette(colors), [colors]);

  const approvals = useMemo(
    () => snapshot.items.filter((item) => item.kind === 'approval'),
    [snapshot.items],
  );
  const alerts = useMemo(
    () => snapshot.items.filter((item) => item.kind === 'alert'),
    [snapshot.items],
  );
  const agentEvents = useMemo(
    () => [...snapshot.sessions].sort((left, right) => (
      new Date(right.lastEventAt).getTime() - new Date(left.lastEventAt).getTime()
    )),
    [snapshot.sessions],
  );
  const reviewItems = useMemo(
    () => snapshot.items.filter((item) => item.kind === 'review'),
    [snapshot.items],
  );

  const totalCount = approvals.length + alerts.length + agentEvents.length + reviewItems.length;
  const visibleCount = filter === 'all'
    ? totalCount
    : filter === 'approvals'
      ? approvals.length
      : filter === 'alerts'
        ? alerts.length
        : filter === 'agents'
          ? agentEvents.length
          : reviewItems.length;

  const filters: Array<{ id: ActivityFilter; label: string; count: number }> = [
    { id: 'all', label: 'All', count: totalCount },
    { id: 'approvals', label: 'Approvals', count: approvals.length },
    { id: 'reviews', label: 'Reviews', count: reviewItems.length },
    { id: 'alerts', label: 'Alerts', count: alerts.length },
    { id: 'agents', label: 'Agents', count: agentEvents.length },
  ];

  const timelineListStyle: CSSProperties = {
    display: 'grid',
    gap: 12,
    marginLeft: 20,
    width: 'calc(100% - 20px)',
    boxSizing: 'border-box',
    borderLeft: `1px solid ${palette.timelineLine}`,
  };

  const content = (
    <div
      style={{
        padding: '0 14px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        width: '100%',
        maxWidth: '100%',
        boxSizing: 'border-box',
        overflow: 'hidden',
        background: palette.background,
      }}
    >
      {(() => {
        const subtitle = approvals.length > 0
          ? `${approvals.length} pending approval${approvals.length === 1 ? '' : 's'}`
          : 'All caught up';
        if (hideHeader) {
          return (
            <p style={{ margin: '8px 0 0', fontSize: 13, fontWeight: 500, color: palette.textSecondary, fontFamily: SYSTEM_FONT }}>
              {subtitle}
            </p>
          );
        }
        return (
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, paddingTop: 8 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 28, fontWeight: 800, letterSpacing: '-0.03em', fontFamily: SYSTEM_FONT, color: palette.textPrimary }}>
                Activity
              </h2>
              <p style={{ margin: '4px 0 0', fontSize: 13, fontWeight: 500, color: palette.textSecondary, fontFamily: SYSTEM_FONT }}>
                {subtitle}
              </p>
            </div>
            <button
              type="button"
              onClick={onBack}
              style={{ minWidth: 44, minHeight: 44, padding: '0 16px', borderRadius: 14, border: `1px solid ${palette.cardBorder}`, background: palette.cardBg, color: palette.doneText, fontSize: 13, fontWeight: 600, fontFamily: SYSTEM_FONT, cursor: 'pointer', WebkitTapHighlightColor: 'transparent' }}
            >
              Done
            </button>
          </div>
        );
      })()}

      <div
        style={{
          display: 'flex',
          gap: 8,
          overflowX: 'auto',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
        }}
      >
        {filters.map((item) => {
          const active = filter === item.id;
          const tone = toneForFilter(item.id);
          const accent = palette.status[tone];

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              style={{
                minHeight: 44,
                padding: '0 14px',
                borderRadius: 14,
                border: `1px solid ${active ? palette.cardBorder : palette.timelineLine}`,
                background: active ? palette.cardBg : palette.background,
                color: active ? palette.textPrimary : palette.textSecondary,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                whiteSpace: 'nowrap',
                fontSize: 12,
                fontWeight: 600,
                fontFamily: SYSTEM_FONT,
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              <span>{item.label}</span>
              {item.count > 0 ? (
                <span
                  style={{
                    minWidth: 20,
                    height: 20,
                    padding: '0 6px',
                    borderRadius: 999,
                    background: active ? accent : palette.cardBg,
                    color: active ? palette.background : palette.textSecondary,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 10,
                    fontWeight: 700,
                    boxSizing: 'border-box',
                  }}
                >
                  {item.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {(filter === 'all' || filter === 'approvals') && approvals.length > 0 ? (
        <section>
          {filter === 'all' ? (
            <SectionHeader label="Pending Approvals" tone="testing" palette={palette} />
          ) : null}
          <div style={timelineListStyle}>
            {approvals.map((item) => (
              <ApprovalCard
                key={item.id}
                item={item}
                onApprove={() => onApprove(item)}
                onDeny={() => onDeny(item)}
                palette={palette}
              />
            ))}
          </div>
        </section>
      ) : null}

      {(filter === 'all' || filter === 'alerts') && alerts.length > 0 ? (
        <section>
          {filter === 'all' ? (
            <SectionHeader label="Alerts" tone="error" palette={palette} />
          ) : null}
          <div style={timelineListStyle}>
            {alerts.map((item) => (
              <AlertCard key={item.id} item={item} palette={palette} />
            ))}
          </div>
        </section>
      ) : null}

      {(filter === 'all' || filter === 'reviews') && reviewItems.length > 0 ? (
        <section>
          {filter === 'all' ? (
            <SectionHeader label="Pull Requests" tone="thinking" palette={palette} />
          ) : null}
          <div style={timelineListStyle}>
            {reviewItems.map((item) => (
              <ReviewCard
                key={item.id}
                item={item}
                palette={palette}
                onOpen={() => {
                  const match = item.title.match(/#(\d+)/);
                  if (match && onReviewPR && item.sessionKey) {
                    onReviewPR(item.sessionKey, Number.parseInt(match[1], 10));
                    return;
                  }
                  onAgentSelect(item.sessionKey || '');
                }}
              />
            ))}
          </div>
        </section>
      ) : null}

      {(filter === 'all' || filter === 'agents') && agentEvents.length > 0 ? (
        <section>
          {filter === 'all' ? (
            <SectionHeader label="Agent Activity" tone="coding" palette={palette} />
          ) : null}
          <div style={timelineListStyle}>
            {agentEvents.map((agent) => (
              <AgentEventCard
                key={agent.id}
                agent={agent}
                palette={palette}
                onSelect={() => onAgentSelect(agent.sessionKey)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {visibleCount === 0 ? (
        <EmptyState
          palette={palette}
          title={filter === 'all' ? 'No activity yet' : `No ${filter} yet`}
          detail={
            filter === 'all'
              ? 'Agent events, approvals, alerts, and reviews will appear here.'
              : 'This lane will fill as new activity arrives.'
          }
        />
      ) : null}
    </div>
  );

  if (!onRefresh) return content;
  return <PullToRefresh onRefresh={onRefresh}>{content}</PullToRefresh>;
});
