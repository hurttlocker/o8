'use client';

import { memo, type CSSProperties, type ReactNode } from 'react';
import type { AgentDisplayName, CompactLine, SessionSummary } from './types';
import { useTheme } from './ThemeContext';

interface RecentSessionPickerProps {
  sessions: SessionSummary[];
  compactLine: CompactLine;
  agentDisplayName: AgentDisplayName;
  onSessionSelect: (sessionId: string) => void;
  onNewChat: () => void;
  onLaunch: () => void;
}

interface SessionAgentPillProps {
  session: SessionSummary;
  compactLine: CompactLine;
  agentDisplayName: AgentDisplayName;
  onClick: () => void;
}

type SessionGroupId = 'working' | 'idle' | 'archived';

interface SessionGroup {
  id: SessionGroupId;
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
  background: '#000000',
  primary: '#F5F5F7',
  secondary: '#8E8E93',
  separator: 'rgba(255,255,255,0.06)',
} as const;

const SESSION_GROUP_ORDER: Array<{ id: SessionGroupId; label: string }> = [
  { id: 'working', label: 'Working' },
  { id: 'idle', label: 'Idle' },
  { id: 'archived', label: 'Archived' },
];

const WORKING_STATUSES = new Set(['running', 'launching']);
const IDLE_STATUSES = new Set(['idle', 'waiting', 'reviewing', 'paused', 'blocked']);
const ARCHIVED_STATUSES = new Set(['completed', 'archived', 'failed']);

function normalizeSessionStatus(session: SessionSummary): string {
  if (session.runtimeSurface?.lifecycle?.availability === 'running') {
    return 'running';
  }

  return String(session.status ?? '').trim().toLowerCase();
}

function sessionGroupId(session: SessionSummary): SessionGroupId {
  const status = normalizeSessionStatus(session);

  if (WORKING_STATUSES.has(status)) return 'working';
  if (ARCHIVED_STATUSES.has(status)) return 'archived';
  if (IDLE_STATUSES.has(status)) return 'idle';

  return 'idle';
}

export function groupSessionsByStatus(sessions: SessionSummary[]): SessionGroup[] {
  const grouped = {
    working: [] as SessionSummary[],
    idle: [] as SessionSummary[],
    archived: [] as SessionSummary[],
  };

  for (const session of sessions) {
    grouped[sessionGroupId(session)].push(session);
  }

  return SESSION_GROUP_ORDER
    .map((group) => ({
      id: group.id,
      label: group.label,
      sessions: grouped[group.id],
    }))
    .filter((group) => group.sessions.length > 0);
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

function MonitorIcon({ color }: { color: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="13"
      height="13"
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
    && prev.status === next.status
    && prev.name === next.name
    && (prev.lastActivityAt ?? null) === (next.lastActivityAt ?? null);
}

export function SessionRowButton({
  title,
  onClick,
}: {
  title: string;
  onClick: () => void;
}) {
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
        color: MOBILE_SESSION_LIST_COLORS.primary,
        textAlign: 'left',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <span
        style={{
          minWidth: 0,
          display: 'grid',
          gap: 4,
        }}
      >
        <span
          style={{
            color: MOBILE_SESSION_LIST_COLORS.primary,
            fontSize: 17,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            lineHeight: 1.2,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            minWidth: 0,
            color: MOBILE_SESSION_LIST_COLORS.secondary,
            fontSize: 14,
            fontWeight: 500,
            lineHeight: 1.2,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          <MonitorIcon color={MOBILE_SESSION_LIST_COLORS.secondary} />
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            Remote control
          </span>
        </span>
      </span>

      <ChevronRightIcon color={MOBILE_SESSION_LIST_COLORS.secondary} />
    </button>
  );
}

const DefaultSessionRow = memo(function DefaultSessionRow({
  session,
  onSessionSelect,
  renderSessionName,
}: GroupedSessionListRowProps) {
  return (
    <SessionRowButton
      title={renderSessionName(session)}
      onClick={() => onSessionSelect(session.id)}
    />
  );
}, (prev, next) => areSessionListRowsEqual(prev.session, next.session));

export function GroupedSessionList({
  sessions,
  onSessionSelect,
  renderSessionName,
  RowComponent = DefaultSessionRow,
  emptyMessage = 'No remote sessions yet.',
  topPadding = 6,
  bottomPadding = 0,
}: GroupedSessionListProps) {
  const groups = groupSessionsByStatus(sessions);

  return (
    <section
      style={{
        width: '100%',
        minHeight: '100%',
        paddingTop: topPadding,
        paddingBottom: bottomPadding,
        background: MOBILE_SESSION_LIST_COLORS.background,
      }}
    >
      {groups.length > 0 ? groups.map((group, groupIndex) => (
        <section key={group.id} style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              padding: `${groupIndex === 0 ? 6 : 18}px 16px 8px`,
              color: MOBILE_SESSION_LIST_COLORS.secondary,
              fontSize: 13,
              fontWeight: 500,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
            }}
          >
            {group.label}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {group.sessions.map((session, sessionIndex) => (
              <div key={session.sessionKey} style={{ display: 'flex', flexDirection: 'column' }}>
                {sessionIndex > 0 ? (
                  <div
                    aria-hidden="true"
                    style={{
                      height: 1,
                      marginLeft: 16,
                      background: MOBILE_SESSION_LIST_COLORS.separator,
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
            color: MOBILE_SESSION_LIST_COLORS.secondary,
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
}: RecentSessionPickerProps) {
  return (
    <GroupedSessionList
      sessions={sessions}
      onSessionSelect={onSessionSelect}
      renderSessionName={(session) => compactLine(session.name, agentDisplayName(session), 56)}
      emptyMessage="No remote sessions yet."
      topPadding={4}
    />
  );
}
