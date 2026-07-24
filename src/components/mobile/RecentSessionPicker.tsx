'use client';

import { memo, type CSSProperties, type ReactNode } from 'react';
import type { AgentDisplayName, CompactLine, SessionSummary } from './types';
import { useTheme } from './ThemeContext';
import {
  isDispatchableRuntime,
  ORCHESTRATOR_RUNTIMES,
} from '@/lib/orchestrator/runtime-capabilities';

interface RecentSessionPickerProps {
  sessions: SessionSummary[];
  compactLine: CompactLine;
  agentDisplayName: AgentDisplayName;
  onSessionSelect: (sessionId: string) => void;
  onNewChat: () => void;
  onLaunch: () => void;
  bottomPadding?: CSSProperties['paddingBottom'];
}

interface SessionAgentPillProps {
  session: SessionSummary;
  compactLine: CompactLine;
  agentDisplayName: AgentDisplayName;
  onClick: () => void;
}

type SessionGroupId = 'working' | 'idle' | 'archived';
type SessionSectionId = 'chats' | 'sessions' | 'missions';

interface SessionSection {
  id: SessionSectionId;
  label: string;
  sessions: SessionSummary[];
}

interface GroupedSessionListProps {
  sessions: SessionSummary[];
  onSessionSelect: (sessionId: string) => void;
  renderSessionName: (session: SessionSummary) => string;
  RowComponent?: (props: GroupedSessionListRowProps) => ReactNode;
  emptyMessage?: string;
  topPadding?: CSSProperties['paddingTop'];
  bottomPadding?: CSSProperties['paddingBottom'];
}

export interface GroupedSessionListRowProps {
  session: SessionSummary;
  onSessionSelect: (sessionId: string) => void;
  renderSessionName: (session: SessionSummary) => string;
}

export const MOBILE_SESSION_LIST_COLORS = {
  background: '#0A0A0A',
  primary: '#FAF5F0',
  secondary: '#A09890',
  separator: 'rgba(255,248,240,0.06)',
} as const;

const SESSION_SECTION_ORDER: Array<{ id: SessionSectionId; label: string }> = [
  { id: 'chats', label: 'Chats' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'missions', label: 'Missions' },
];

const WORKING_STATUSES = new Set(['running', 'launching']);
const IDLE_STATUSES = new Set(['idle', 'waiting', 'reviewing', 'paused', 'blocked']);
const ARCHIVED_STATUSES = new Set(['completed', 'archived', 'failed']);
const WORKING_PACKET_STATUSES = new Set(['running', 'launching']);
const IDLE_PACKET_STATUSES = new Set(['draft', 'queued', 'idle', 'awaiting_review', 'recovering', 'blocked']);
const ARCHIVED_PACKET_STATUSES = new Set(['released', 'archived']);
const SESSION_PREFIXES = ['codex-owned:', 'codex-discovered:', 'codex:', 'claude-code:'];
const SECTION_HEADER_COLOR = '#A09890';

function withAlpha(color: string, alpha: number) {
  const normalized = color.trim();
  if (!normalized.startsWith('#')) return normalized;
  const hex = normalized.slice(1);
  const expanded = hex.length === 3
    ? hex.split('').map((segment) => segment + segment).join('')
    : hex;
  if (expanded.length !== 6) return normalized;
  const r = Number.parseInt(expanded.slice(0, 2), 16);
  const g = Number.parseInt(expanded.slice(2, 4), 16);
  const b = Number.parseInt(expanded.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function humanizeStatus(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return 'Idle';
  return trimmed
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (segment) => segment.toUpperCase());
}

function sessionTimestamp(session: SessionSummary): number {
  if (typeof session.lastActivityAt === 'number' && Number.isFinite(session.lastActivityAt)) {
    return session.lastActivityAt;
  }

  const lifecycleTime = session.runtimeSurface?.lifecycle?.lastRunFinishedAt
    ?? session.runtimeSurface?.lifecycle?.lastRunStartedAt
    ?? null;
  if (!lifecycleTime) return 0;

  const parsed = new Date(lifecycleTime).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function sessionSortLabel(session: SessionSummary): string {
  return (
    session.orchestrationPacket?.title?.trim()
    || session.name?.trim()
    || session.surfaceLabel?.trim()
    || session.currentTask?.trim()
    || session.sessionKey
  ).toLowerCase();
}

function sessionMatchFields(session: SessionSummary) {
  return [
    session.orchestrationPacket?.packetId,
    session.orchestrationPacket?.title,
    session.orchestrationPacket?.referenceLabel,
    session.sessionKey,
    session.name,
    session.workspace,
    session.runtimeSurface?.cwd,
    session.runtimeSurface?.reviewContext?.branch,
    session.currentTask,
    session.branch,
  ];
}

function extractMatch(session: SessionSummary, pattern: RegExp): string | null {
  for (const value of sessionMatchFields(session)) {
    if (!value) continue;
    const match = value.match(pattern);
    if (match?.[0]) return match[0];
  }
  return null;
}

function hasWorktreePath(session: SessionSummary) {
  const sources = [session.workspace, session.runtimeSurface?.cwd]
    .map((value) => value?.toLowerCase() ?? '');
  return sources.some((value) => value.includes('/.cortex-worktrees/') || value.includes('/.claude/worktrees/'));
}

function extractMissionWave(session: SessionSummary): number | null {
  for (const value of sessionMatchFields(session)) {
    if (!value) continue;
    const match = value.match(/\bwave\s*#?\s*(\d+)\b/i);
    if (!match?.[1]) continue;
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeSessionStatus(session: SessionSummary): string {
  if (session.runtimeSurface?.lifecycle?.availability === 'running') {
    return 'running';
  }

  return String(session.status ?? '').trim().toLowerCase();
}

function sessionGroupId(session: SessionSummary): SessionGroupId {
  const packetStatus = String(session.orchestrationPacket?.status ?? '').trim().toLowerCase();
  if (WORKING_PACKET_STATUSES.has(packetStatus)) return 'working';
  if (ARCHIVED_PACKET_STATUSES.has(packetStatus)) return 'archived';
  if (IDLE_PACKET_STATUSES.has(packetStatus)) return 'idle';

  const status = normalizeSessionStatus(session);
  if (WORKING_STATUSES.has(status)) return 'working';
  if (ARCHIVED_STATUSES.has(status)) return 'archived';
  if (IDLE_STATUSES.has(status)) return 'idle';

  return 'idle';
}

function sessionGroupRank(session: SessionSummary): number {
  switch (sessionGroupId(session)) {
    case 'working':
      return 0;
    case 'idle':
      return 1;
    case 'archived':
      return 2;
    default:
      return 1;
  }
}

function isChatSession(session: SessionSummary) {
  return session.sessionKey.startsWith('llm-chat:');
}

function isMissionSession(session: SessionSummary) {
  return Boolean(session.orchestrationPacket)
    || Boolean(extractMatch(session, /\bpacket-[a-z0-9-]+\b/i))
    || hasWorktreePath(session);
}

function sessionSectionId(session: SessionSummary): SessionSectionId {
  if (isChatSession(session)) return 'chats';
  if (isMissionSession(session)) return 'missions';
  if (SESSION_PREFIXES.some((prefix) => session.sessionKey.startsWith(prefix))) return 'sessions';
  return 'sessions';
}

function compareSectionSessions(left: SessionSummary, right: SessionSummary) {
  const groupDiff = sessionGroupRank(left) - sessionGroupRank(right);
  if (groupDiff !== 0) return groupDiff;

  const timeDiff = sessionTimestamp(right) - sessionTimestamp(left);
  if (timeDiff !== 0) return timeDiff;

  return sessionSortLabel(left).localeCompare(sessionSortLabel(right));
}

export function groupSessionsByType(sessions: SessionSummary[]): SessionSection[] {
  const grouped = {
    chats: [] as SessionSummary[],
    sessions: [] as SessionSummary[],
    missions: [] as SessionSummary[],
  };

  for (const session of sessions) {
    grouped[sessionSectionId(session)].push(session);
  }

  return SESSION_SECTION_ORDER
    .map((section) => ({
      id: section.id,
      label: section.label,
      sessions: [...grouped[section.id]].sort(compareSectionSessions),
    }))
    .filter((section) => section.sessions.length > 0);
}

function ChevronDownIcon({ color }: { color: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function MonitorIcon({ color, size = 13 }: { color: string; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <rect x="3.5" y="4.5" width="17" height="11" rx="1.5" />
      <path d="M9 19.5h6" />
      <path d="M12 15.5v4" />
    </svg>
  );
}

function ChatBubbleIcon({ color, size = 13 }: { color: string; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <path d="M7 18.5 3.5 20V6.75A2.25 2.25 0 0 1 5.75 4.5h12.5a2.25 2.25 0 0 1 2.25 2.25v7.5a2.25 2.25 0 0 1-2.25 2.25H7Z" />
      <path d="M8 9h8" />
      <path d="M8 13h5" />
    </svg>
  );
}

function RocketIcon({ color, size = 13 }: { color: string; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <path d="M14.5 4.5c2.9.2 5 2.6 5 5.5 0 3.7-3.1 6.7-7.4 7.2L8.5 20l2.8-3.6C11.8 12 14.8 9 18.5 9c0-2.9-2.1-5.3-4-4.5Z" />
      <path d="M8.5 15.5 5 19" />
      <path d="M9 9.5 4.5 14" />
      <circle cx="15.25" cy="8.75" r="1.25" />
    </svg>
  );
}

function ChevronRightIcon({ color }: { color: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <path d="m10 6 6 6-6 6" />
    </svg>
  );
}

export function areSessionListRowsEqual(prev: SessionSummary, next: SessionSummary) {
  return prev.sessionKey === next.sessionKey
    && prev.runtime === next.runtime
    && prev.status === next.status
    && prev.name === next.name
    && prev.currentTask === next.currentTask
    && prev.lastEventAt === next.lastEventAt
    && prev.workspace === next.workspace
    && (prev.lastActivityAt ?? null) === (next.lastActivityAt ?? null)
    && prev.runtimeSurface?.cwd === next.runtimeSurface?.cwd
    && prev.runtimeSurface?.lifecycle?.availability === next.runtimeSurface?.lifecycle?.availability
    && prev.runtimeSurface?.lifecycle?.lastOutcome === next.runtimeSurface?.lifecycle?.lastOutcome
    && prev.orchestrationPacket?.packetId === next.orchestrationPacket?.packetId
    && prev.orchestrationPacket?.referenceLabel === next.orchestrationPacket?.referenceLabel
    && prev.orchestrationPacket?.title === next.orchestrationPacket?.title
    && prev.orchestrationPacket?.status === next.orchestrationPacket?.status;
}

export function SessionRowButton({
  onClick,
  children,
  trailing,
}: {
  onClick: () => void;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  const { colors } = useTheme();

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        minHeight: 44,
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        border: 'none',
        background: 'transparent',
        color: colors.text,
        textAlign: 'left',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <span style={{ minWidth: 0, flex: 1 }}>
        {children}
      </span>

      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          flexShrink: 0,
        }}
      >
        {trailing}
        <ChevronRightIcon color={colors.textSecondary} />
      </span>
    </button>
  );
}

const DefaultSessionRow = memo(function DefaultSessionRow({
  session,
  onSessionSelect,
  renderSessionName,
}: GroupedSessionListRowProps) {
  const { colors } = useTheme();
  const section = sessionSectionId(session);
  const titleStyle: CSSProperties = {
    color: colors.text,
    fontSize: 17,
    fontWeight: 600,
    letterSpacing: '-0.02em',
    lineHeight: 1.2,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
  const detailStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: 500,
    lineHeight: 1.25,
  };

  if (section === 'chats') {
    const title = session.name?.trim() || session.surfaceLabel?.trim() || 'New Chat';
    const preview = session.currentTask?.trim() || 'Start a conversation.';
    const timeAgo = session.lastEventAt?.trim() || 'just now';

    return (
      <SessionRowButton onClick={() => onSessionSelect(session.id)} trailing={(
        <span
          style={{
            color: colors.textSecondary,
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '-0.01em',
          }}
        >
          {timeAgo}
        </span>
      )}
      >
        <span style={{ minWidth: 0, display: 'grid', gap: 4 }}>
          <span style={titleStyle}>{title}</span>
          <span
            style={{
              ...detailStyle,
              display: 'block',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {preview}
          </span>
        </span>
      </SessionRowButton>
    );
  }

  if (section === 'missions') {
    const missionTitle = session.orchestrationPacket?.title?.trim()
      || session.name?.trim()
      || renderSessionName(session)
      || 'Mission packet';
    const packetRef = session.orchestrationPacket?.referenceLabel?.trim() || null;
    const wave = extractMissionWave(session);
    const packetToken = extractMatch(session, /\bpacket-[a-z0-9-]+\b/i);
    const workspaceLabel = session.runtimeSurface?.reviewContext?.repoSlug?.split('/').pop()?.trim()
      || session.workspace?.replace(/^~\//, '').split('/').filter(Boolean).pop()
      || null;
    const metaLine = [packetRef, wave ? `Wave ${wave}` : null, workspaceLabel, !packetRef && !workspaceLabel ? packetToken : null]
      .filter((value): value is string => Boolean(value));
    const missionGroup = sessionGroupId(session);
    const badgeColor = missionGroup === 'working'
      ? colors.green
      : missionGroup === 'archived'
        ? colors.activityStatusIdle
        : colors.activityStatusTesting;

    return (
      <SessionRowButton onClick={() => onSessionSelect(session.id)} trailing={(
        <span
          style={{
            minHeight: 24,
            padding: '0 9px',
            borderRadius: 999,
            border: `1px solid ${withAlpha(badgeColor, 0.24)}`,
            background: withAlpha(badgeColor, 0.12),
            color: badgeColor,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.02em',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            whiteSpace: 'nowrap',
          }}
        >
          {humanizeStatus(session.orchestrationPacket?.status ?? normalizeSessionStatus(session))}
        </span>
      )}
      >
        <span style={{ minWidth: 0, display: 'grid', gap: 4 }}>
          <span style={titleStyle}>{missionTitle}</span>
          <span
            style={{
              ...detailStyle,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {metaLine.join(' · ') || 'Mission packet'}
          </span>
        </span>
      </SessionRowButton>
    );
  }

  const title = renderSessionName(session) || session.name?.trim() || session.surfaceLabel?.trim() || 'Agent';
  const task = session.currentTask?.trim() || 'Waiting for input.';
  const runtimeCapability = isDispatchableRuntime(session.runtime)
    ? ORCHESTRATOR_RUNTIMES[session.runtime]
    : null;
  const liveGroup = sessionGroupId(session);
  const dotColor = liveGroup === 'working'
    ? colors.green
    : liveGroup === 'archived'
      ? colors.activityStatusIdle
      : colors.activityStatusTesting;

  return (
    <SessionRowButton onClick={() => onSessionSelect(session.id)}>
      <span style={{ minWidth: 0, display: 'grid', gap: 4 }}>
        <span style={titleStyle}>{title}</span>
        <span
          style={{
            ...detailStyle,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: dotColor,
              flexShrink: 0,
            }}
          />
          {runtimeCapability ? (
            <span
              style={{
                color: runtimeCapability.accentColor,
                flexShrink: 0,
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              {runtimeCapability.label}
            </span>
          ) : null}
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {task}
          </span>
        </span>
      </span>
    </SessionRowButton>
  );
}, (prev, next) => areSessionListRowsEqual(prev.session, next.session));

export function GroupedSessionList({
  sessions,
  onSessionSelect,
  renderSessionName,
  RowComponent = DefaultSessionRow,
  emptyMessage = 'No sessions yet.',
  topPadding = 6,
  bottomPadding = 0,
}: GroupedSessionListProps) {
  const { colors } = useTheme();
  const sections = groupSessionsByType(sessions);

  const sectionIcon = (id: SessionSectionId) => {
    switch (id) {
      case 'chats':
        return <ChatBubbleIcon color={SECTION_HEADER_COLOR} size={13} />;
      case 'missions':
        return <RocketIcon color={SECTION_HEADER_COLOR} size={13} />;
      case 'sessions':
      default:
        return <MonitorIcon color={SECTION_HEADER_COLOR} size={13} />;
    }
  };

  return (
    <section
      style={{
        width: '100%',
        minHeight: '100%',
        paddingTop: topPadding,
        paddingBottom: bottomPadding,
        background: colors.bg,
      }}
    >
      {sections.length > 0 ? sections.map((section) => (
        <section key={section.id} style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              marginTop: 24,
              marginBottom: 8,
              paddingLeft: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: SECTION_HEADER_COLOR,
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            {sectionIcon(section.id)}
            <span>{section.label}</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {section.sessions.map((session, sessionIndex) => (
              <div key={session.sessionKey} style={{ display: 'flex', flexDirection: 'column' }}>
                {sessionIndex > 0 ? (
                  <div
                    aria-hidden="true"
                    style={{
                      height: 1,
                      marginLeft: 16,
                      background: colors.border,
                    }}
                  />
                ) : null}
                <RowComponent
                  session={session}
                  onSessionSelect={onSessionSelect}
                  renderSessionName={renderSessionName}
                />
              </div>
            ))}
          </div>
        </section>
      )) : (
        <div
          style={{
            padding: '24px 16px',
            color: colors.textSecondary,
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          {emptyMessage}
        </div>
      )}
    </section>
  );
}

export const SessionAgentPill = memo(function SessionAgentPill({
  session,
  compactLine,
  agentDisplayName,
  onClick,
}: SessionAgentPillProps) {
  const { colors } = useTheme();

  const buttonStyle: CSSProperties = {
    width: 'calc(100% - 28px)',
    margin: 'calc(env(safe-area-inset-top, 0px) + 68px) 14px 12px',
    padding: '12px 14px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderRadius: 14,
    border: `1px solid ${colors.cardBorder}`,
    background: colors.cardBg,
    color: colors.text,
    boxShadow: '0 14px 30px rgba(0,0,0,0.28)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    WebkitTapHighlightColor: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
  };

  return (
    <button type="button" onClick={onClick} style={buttonStyle}>
      <span style={{ minWidth: 0, display: 'grid', gap: 4 }}>
        <span
          style={{
            color: colors.textSecondary,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          Active agent
        </span>
        <span
          style={{
            color: colors.text,
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {compactLine(session.name, agentDisplayName(session), 34)}
        </span>
      </span>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          color: colors.textSecondary,
          fontSize: 12,
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        <span>{compactLine(session.lastEventAt, 'now', 12)}</span>
        <ChevronDownIcon color={colors.textSecondary} />
      </span>
    </button>
  );
}, (prev, next) => areSessionListRowsEqual(prev.session, next.session));

export function RecentSessionPicker({
  sessions,
  compactLine,
  agentDisplayName,
  onSessionSelect,
  bottomPadding,
}: RecentSessionPickerProps) {
  return (
    <GroupedSessionList
      sessions={sessions}
      onSessionSelect={onSessionSelect}
      renderSessionName={(session) => compactLine(session.name, agentDisplayName(session), 56)}
      emptyMessage="No sessions yet."
      topPadding={4}
      bottomPadding={bottomPadding}
    />
  );
}
