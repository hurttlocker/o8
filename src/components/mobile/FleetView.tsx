'use client';

import { memo, useCallback, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type { AgentSummary } from '@/lib/fleet/types';
import { useLongPress, ContextMenu, type ContextMenuItem } from './ContextMenu';
import { EmptyState } from './EmptyState';
import { useTheme } from './ThemeContext';

interface FleetViewProps {
  snapshot: MobileInboxSnapshot;
  onAgentSelect: (sessionKey: string) => void;
  onBack: () => void;
  onLaunch: () => void;
}

interface FleetAgentItem {
  agent: AgentSummary;
  pendingApprovalCount: number;
  hasMergeConflict: boolean;
}

type AgentCardTier = 'attention' | 'active' | 'quiet';

const ACTIVE_STATUSES = new Set<AgentSummary['status']>(['running', 'reviewing', 'waiting']);

function withAlpha(color: string, alpha: number): string {
  const normalized = color.trim();
  if (!normalized.startsWith('#')) {
    return color;
  }

  const hex = normalized.slice(1);
  const expanded = hex.length === 3
    ? hex.split('').map((char) => `${char}${char}`).join('')
    : hex;

  if (expanded.length !== 6) {
    return color;
  }

  const r = Number.parseInt(expanded.slice(0, 2), 16);
  const g = Number.parseInt(expanded.slice(2, 4), 16);
  const b = Number.parseInt(expanded.slice(4, 6), 16);

  if ([r, g, b].some((channel) => Number.isNaN(channel))) {
    return color;
  }

  return `rgba(${r},${g},${b},${alpha})`;
}

function formatRelativeTime(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return 'just now';
  if (/^(just now|\d+[mhd] ago)$/i.test(trimmed)) return trimmed;

  const timestamp = new Date(trimmed).getTime();
  if (Number.isNaN(timestamp)) return trimmed;

  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function shortModel(model: string): string {
  return model
    .replace('anthropic/', '')
    .replace('openai-codex/', '')
    .replace('openai/', '')
    .replace('claude-', '')
    .split('-')
    .slice(0, 2)
    .join('-');
}

function hasMergeConflictSignal(agent: AgentSummary): boolean {
  const signal = [
    agent.currentTask,
    agent.activity?.headline,
    agent.runtimeSurface?.lifecycle?.summary,
    agent.orchestrationPacket?.title,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(' ');

  if (!signal) return false;
  if (/\bno conflicts?\b/i.test(signal)) return false;
  return /\bmerge conflicts?\b|\bconflicts?\b/i.test(signal);
}

function attentionReasons(item: FleetAgentItem): string[] {
  const reasons: string[] = [];

  if (item.pendingApprovalCount > 0) {
    reasons.push(`${item.pendingApprovalCount} approval${item.pendingApprovalCount === 1 ? '' : 's'} pending`);
  }
  if (item.agent.status === 'blocked') {
    reasons.push('Blocked');
  }
  if (item.agent.status === 'failed') {
    reasons.push('Failed');
  }
  if (item.hasMergeConflict) {
    reasons.push('Merge conflicts');
  }

  return reasons;
}

function statusLabel(agent: AgentSummary): string {
  if (agent.status === 'running') return 'Running';
  if (agent.status === 'reviewing') return 'Reviewing';
  if (agent.status === 'waiting') return 'Waiting';
  if (agent.status === 'blocked') return 'Blocked';
  if (agent.status === 'failed') return 'Failed';
  return agent.currentTask.trim() ? 'Done' : 'Idle';
}

function contextTone(percent: number, colors: ReturnType<typeof useTheme>['colors']) {
  if (percent >= 95) return colors.red;
  if (percent >= 80) return colors.amber;
  if (percent >= 60) return colors.green;
  return colors.blueAccent;
}

function ContextProgressRing({
  percent,
  colors,
  size = 40,
}: {
  percent: number;
  colors: ReturnType<typeof useTheme>['colors'];
  size?: number;
}) {
  const normalizedPercent = Math.max(0, Math.min(100, Math.round(percent)));
  const ringColor = contextTone(normalizedPercent, colors);
  const trackColor = withAlpha(colors.text, 0.12);

  return (
    <div
      aria-label={`${normalizedPercent}% context used`}
      style={{
        position: 'relative',
        width: size,
        height: size,
        borderRadius: '50%',
        background: `conic-gradient(${ringColor} ${normalizedPercent * 3.6}deg, ${trackColor} 0deg)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: size - 8,
          height: size - 8,
          borderRadius: '50%',
          background: colors.bg,
          border: `1px solid ${withAlpha(colors.text, 0.08)}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 700,
          color: colors.text,
          letterSpacing: '-0.02em',
          fontFamily: '"SF Mono", ui-monospace, monospace',
        }}
      >
        {normalizedPercent}
      </div>
    </div>
  );
}

function SectionHeader({
  label,
  count,
  colors,
  collapsible = false,
  open = true,
  onToggle,
}: {
  label: string;
  count: number;
  colors: ReturnType<typeof useTheme>['colors'];
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
}) {
  const labelNode = (
    <>
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: colors.textSecondary,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: colors.textTertiary,
          letterSpacing: '0.02em',
        }}
      >
        {count}
      </span>
    </>
  );

  if (!collapsible) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        {labelNode}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        minHeight: 44,
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '0 0 4px',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        textAlign: 'left',
      }}
    >
      {labelNode}
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke={colors.textTertiary}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          flexShrink: 0,
          transition: 'transform 180ms ease',
          transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        }}
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );
}

function AgentCard({
  item,
  tier,
  colors,
  onSelect,
  onKill,
  onMessage,
}: {
  item: FleetAgentItem;
  tier: AgentCardTier;
  colors: ReturnType<typeof useTheme>['colors'];
  onSelect: () => void;
  onKill?: () => void;
  onMessage?: () => void;
}) {
  const { agent } = item;
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const longPress = useLongPress((x, y) => setCtxMenu({ x, y }));

  const ctxItems: ContextMenuItem[] = [
    { id: 'message', label: 'Message', iconPath: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
    ...(agent.status === 'running'
      ? [{
          id: 'kill',
          label: 'Stop Agent',
          iconPath: 'M18 6L6 18 M6 6l12 12',
          destructive: true,
        }]
      : []),
  ];

  const handleCtxSelect = useCallback((id: string) => {
    if (id === 'message') onMessage?.() ?? onSelect();
    if (id === 'kill') onKill?.();
    setCtxMenu(null);
  }, [onKill, onMessage, onSelect]);

  const isAttention = tier === 'attention';
  const isQuiet = tier === 'quiet';
  const metaTextColor = isAttention ? withAlpha(colors.text, 0.78) : isQuiet ? colors.textTertiary : colors.textSecondary;
  const tertiaryTextColor = isAttention ? withAlpha(colors.text, 0.64) : colors.textTertiary;
  const titleColor = isQuiet ? colors.textTertiary : colors.text;
  const task = agent.currentTask.trim() || (isQuiet ? 'Idle' : 'No active task');
  const detailPills = isAttention
    ? attentionReasons(item)
    : [statusLabel(agent), `${Math.max(0, Math.round(agent.context?.usedPercent ?? 0))}% context`];

  let cardStyle: CSSProperties;
  if (isAttention) {
    cardStyle = {
      width: '100%',
      minHeight: 44,
      padding: 14,
      border: 'none',
      borderLeft: `3px solid ${colors.red}`,
      borderRadius: 14,
      background: withAlpha(colors.red, 0.12),
      color: colors.text,
      cursor: 'pointer',
      WebkitTapHighlightColor: 'transparent',
      textAlign: 'left',
    };
  } else if (tier === 'active') {
    cardStyle = {
      width: '100%',
      minHeight: 44,
      padding: 14,
      border: 'none',
      borderRadius: 14,
      background: colors.blueSoft,
      color: colors.text,
      cursor: 'pointer',
      WebkitTapHighlightColor: 'transparent',
      textAlign: 'left',
    };
  } else {
    cardStyle = {
      width: '100%',
      minHeight: 44,
      padding: '10px 0',
      border: 'none',
      background: 'transparent',
      color: colors.textTertiary,
      cursor: 'pointer',
      WebkitTapHighlightColor: 'transparent',
      textAlign: 'left',
    };
  }

  return (
    <>
      <button
        type="button"
        onClick={onSelect}
        {...longPress}
        style={cardStyle}
      >
        <div
          style={{
            display: 'flex',
            alignItems: isQuiet ? 'center' : 'flex-start',
            gap: 12,
            width: '100%',
          }}
        >
          {tier === 'active' ? (
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <ContextProgressRing percent={agent.context?.usedPercent ?? 0} colors={colors} />
              <span
                style={{
                  position: 'absolute',
                  right: -1,
                  bottom: -1,
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: colors.blueAccent,
                  border: `2px solid ${colors.bg}`,
                  boxShadow: `0 0 0 3px ${withAlpha(colors.blueAccent, 0.2)}`,
                }}
              />
            </div>
          ) : null}

          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <div
                style={{
                  minWidth: 0,
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'baseline',
                  gap: 8,
                }}
              >
                <span
                  style={{
                    fontSize: isQuiet ? 14 : 15,
                    fontWeight: isAttention ? 700 : 600,
                    color: titleColor,
                    letterSpacing: isQuiet ? '-0.01em' : '-0.02em',
                  }}
                >
                  {agent.name}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: metaTextColor,
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    letterSpacing: '-0.01em',
                  }}
                >
                  {shortModel(agent.model)}
                </span>
              </div>
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 11,
                  fontWeight: 500,
                  color: tertiaryTextColor,
                  marginTop: isQuiet ? 1 : 2,
                }}
              >
                {formatRelativeTime(agent.lastEventAt)}
              </span>
            </div>

            <p
              style={{
                margin: isQuiet ? '4px 0 0' : '6px 0 0',
                fontSize: isQuiet ? 14 : 14,
                lineHeight: 1.4,
                fontWeight: isAttention ? 600 : 500,
                color: isQuiet ? colors.textTertiary : colors.text,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {task}
            </p>

            {!isQuiet ? (
              <>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    marginTop: 10,
                  }}
                >
                  {detailPills.map((detail) => (
                    <span
                      key={detail}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        minHeight: 24,
                        padding: '0 8px',
                        borderRadius: 999,
                        background: isAttention ? withAlpha(colors.text, 0.08) : withAlpha(colors.blueAccent, 0.12),
                        color: isAttention ? colors.text : colors.textSecondary,
                        fontSize: 11,
                        fontWeight: 600,
                        letterSpacing: '0.01em',
                      }}
                    >
                      {detail}
                    </span>
                  ))}
                </div>

                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 10,
                    marginTop: 10,
                    fontSize: 12,
                    color: metaTextColor,
                  }}
                >
                  {agent.branch ? (
                    <span
                      style={{
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                      }}
                    >
                      {agent.branch}
                    </span>
                  ) : null}
                  {agent.workspace ? (
                    <span
                      style={{
                        color: tertiaryTextColor,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {agent.workspace}
                    </span>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>

          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke={isQuiet ? colors.textTertiary : metaTextColor}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0, marginTop: isQuiet ? 0 : 2 }}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </div>
      </button>
      {ctxMenu ? (
        <ContextMenu
          visible={true}
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxItems}
          onSelect={handleCtxSelect}
          onClose={() => setCtxMenu(null)}
        />
      ) : null}
    </>
  );
}

function SectionBlock({
  header,
  children,
}: {
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {header}
      {children}
    </section>
  );
}

export const FleetView = memo(function FleetView({
  snapshot,
  onAgentSelect,
  onBack,
  onLaunch,
}: FleetViewProps) {
  const { colors } = useTheme();
  const [quietOpen, setQuietOpen] = useState(false);

  const {
    attentionAgents,
    activeAgents,
    quietAgents,
    pendingApprovalsCount,
    blockedAgentsCount,
    conflictAgentsCount,
  } = useMemo(() => {
    const approvalsBySession = new Map<string, number>();
    for (const approval of snapshot.approvals) {
      approvalsBySession.set(approval.sessionKey, (approvalsBySession.get(approval.sessionKey) ?? 0) + 1);
    }

    const attention: FleetAgentItem[] = [];
    const active: FleetAgentItem[] = [];
    const quiet: FleetAgentItem[] = [];
    let blockedCount = 0;
    let conflictCount = 0;

    for (const agent of snapshot.sessions) {
      const pendingApprovalCount = approvalsBySession.get(agent.sessionKey) ?? (agent.approvalStatus === 'pending' ? 1 : 0);
      const hasMergeConflict = hasMergeConflictSignal(agent);
      const needsAttention = pendingApprovalCount > 0
        || agent.status === 'blocked'
        || agent.status === 'failed'
        || hasMergeConflict;

      if (agent.status === 'blocked' || agent.status === 'failed') {
        blockedCount += 1;
      }
      if (hasMergeConflict) {
        conflictCount += 1;
      }

      const item: FleetAgentItem = {
        agent,
        pendingApprovalCount,
        hasMergeConflict,
      };

      if (needsAttention) {
        attention.push(item);
        continue;
      }

      if (ACTIVE_STATUSES.has(agent.status)) {
        active.push(item);
        continue;
      }

      quiet.push(item);
    }

    return {
      attentionAgents: attention,
      activeAgents: active,
      quietAgents: quiet,
      pendingApprovalsCount: snapshot.approvals.length,
      blockedAgentsCount: blockedCount,
      conflictAgentsCount: conflictCount,
    };
  }, [snapshot.approvals, snapshot.sessions]);

  const totalAgents = snapshot.sessions.length;
  const activeCount = activeAgents.length;
  const attentionCount = attentionAgents.length;

  return (
    <div
      style={{
        width: '100%',
        maxWidth: '100%',
        minHeight: '100%',
        padding: '0 14px 24px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        overflow: 'hidden',
        background: colors.bg,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          paddingTop: 8,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h2
            style={{
              margin: 0,
              fontSize: 28,
              fontWeight: 800,
              color: colors.text,
              letterSpacing: '-0.03em',
            }}
          >
            Agents
          </h2>
          <p
            style={{
              margin: '4px 0 0',
              fontSize: 13,
              fontWeight: 500,
              color: colors.textSecondary,
            }}
          >
            {attentionCount} need attention · {activeCount} active · {totalAgents - attentionCount - activeCount} quiet
          </p>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={onLaunch}
            style={{
              minHeight: 44,
              padding: '0 16px',
              borderRadius: 12,
              border: 'none',
              background: colors.blueAccent,
              color: colors.text,
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            Launch
          </button>
          <button
            type="button"
            onClick={onBack}
            style={{
              minHeight: 44,
              padding: '0 16px',
              borderRadius: 12,
              border: `1px solid ${withAlpha(colors.text, 0.08)}`,
              background: withAlpha(colors.text, 0.06),
              color: colors.text,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            Done
          </button>
        </div>
      </div>

      {attentionAgents.length > 0 ? (
        <SectionBlock
          header={(
            <SectionHeader
              label="Needs Attention"
              count={attentionAgents.length}
              colors={colors}
            />
          )}
        >
          {pendingApprovalsCount > 0 || blockedAgentsCount > 0 || conflictAgentsCount > 0 ? (
            <p
              style={{
                margin: 0,
                fontSize: 13,
                lineHeight: 1.5,
                color: colors.textSecondary,
              }}
            >
              {[
                pendingApprovalsCount > 0 ? `${pendingApprovalsCount} pending approval${pendingApprovalsCount === 1 ? '' : 's'}` : null,
                blockedAgentsCount > 0 ? `${blockedAgentsCount} blocked agent${blockedAgentsCount === 1 ? '' : 's'}` : null,
                conflictAgentsCount > 0 ? `${conflictAgentsCount} merge conflict${conflictAgentsCount === 1 ? '' : 's'}` : null,
              ].filter(Boolean).join(' · ')}
            </p>
          ) : null}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {attentionAgents.map((item) => (
              <AgentCard
                key={item.agent.id}
                item={item}
                tier="attention"
                colors={colors}
                onSelect={() => onAgentSelect(item.agent.sessionKey)}
              />
            ))}
          </div>
        </SectionBlock>
      ) : null}

      {activeAgents.length > 0 ? (
        <SectionBlock
          header={(
            <SectionHeader
              label="Active Work"
              count={activeAgents.length}
              colors={colors}
            />
          )}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {activeAgents.map((item) => (
              <AgentCard
                key={item.agent.id}
                item={item}
                tier="active"
                colors={colors}
                onSelect={() => onAgentSelect(item.agent.sessionKey)}
              />
            ))}
          </div>
        </SectionBlock>
      ) : null}

      {quietAgents.length > 0 ? (
        <SectionBlock
          header={(
            <SectionHeader
              label="Done / Idle"
              count={quietAgents.length}
              colors={colors}
              collapsible
              open={quietOpen}
              onToggle={() => setQuietOpen((current) => !current)}
            />
          )}
        >
          {quietOpen ? (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {quietAgents.map((item) => (
                <AgentCard
                  key={item.agent.id}
                  item={item}
                  tier="quiet"
                  colors={colors}
                  onSelect={() => onAgentSelect(item.agent.sessionKey)}
                />
              ))}
            </div>
          ) : null}
        </SectionBlock>
      ) : null}

      {totalAgents === 0 ? (
        <EmptyState
          iconPath="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75"
          title="No agents running"
          subtitle="Launch one to get started."
          actionLabel="Launch Agent"
          onAction={onLaunch}
        />
      ) : null}
    </div>
  );
});
