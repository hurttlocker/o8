import { memo, useMemo, type CSSProperties } from 'react';
import type { SessionSummary, SquadRailProps } from './types';
import { useTheme } from './ThemeContext';
import { MobileListRow, MobileSectionLabel } from './ReferencePrimitives';

function sessionPriority(session: SessionSummary, selectedSession?: SessionSummary) {
  if (session.id === selectedSession?.id) return 1000;
  if (session.status === 'running' || session.runtimeSurface?.lifecycle?.availability === 'running') return 900;
  if (session.status === 'reviewing') return 820;
  if (session.status === 'blocked' || session.status === 'waiting') return 760;
  if (session.isCurrentSession) return 700;
  if (session.status === 'failed') return 300;
  return 500;
}

function isInProgress(session: SessionSummary, selectedSession?: SessionSummary) {
  if (session.id === selectedSession?.id) return true;
  if (session.isCurrentSession) return true;
  if (session.runtimeSurface?.lifecycle?.availability === 'running') return true;
  return ['running', 'reviewing', 'blocked', 'waiting'].includes(session.status);
}

function MonitorIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size}
      height={size}
    >
      <rect x="3" y="4" width="18" height="12" rx="2.5" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
    </svg>
  );
}

export const SquadRail = memo(function SquadRail({
  snapshot,
  selectedSession,
  onSessionFocus,
  compactLine,
}: SquadRailProps) {
  const { colors } = useTheme();

  const orderedSessions = useMemo(
    () => [...snapshot.sessions].sort((left, right) => (
      sessionPriority(right, selectedSession) - sessionPriority(left, selectedSession)
    )),
    [selectedSession, snapshot.sessions],
  );

  const inProgress = orderedSessions.filter((session) => isInProgress(session, selectedSession));
  const archived = orderedSessions.filter((session) => !isInProgress(session, selectedSession));

  const surfaceBg = colors.surface;
  const surfaceBorder = colors.surfaceBorder;
  const secondaryText = colors.textSecondary;

  const sectionStyle: CSSProperties = {
    display: 'grid',
    gap: 28,
    minHeight: 'calc(100vh - 160px)',
    paddingTop: 18,
  };

  const groupStyle: CSSProperties = {
    display: 'grid',
    gap: 10,
  };

  const stackStyle: CSSProperties = {
    display: 'grid',
    gap: 8,
  };

  const emptyStateStyle: CSSProperties = {
    margin: 0,
    padding: '16px 18px',
    borderRadius: 14,
    border: `1px solid ${surfaceBorder}`,
    background: surfaceBg,
    color: secondaryText,
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
    fontSize: '0.92rem',
    lineHeight: 1.5,
    boxShadow: '0 14px 28px rgba(0,0,0,0.24)',
    backdropFilter: 'blur(18px)',
    WebkitBackdropFilter: 'blur(18px)',
  };

  const renderRow = (session: SessionSummary) => (
    <MobileListRow
      key={session.id}
      title={compactLine(session.currentTask ?? session.name, session.name ?? session.sessionKey, 56)}
      subtitle="Remote control"
      selected={session.id === selectedSession?.id}
      leadingIcon={<MonitorIcon size={13} />}
      onClick={() => onSessionFocus(session.id)}
    />
  );

  return (
    <section style={sectionStyle}>
      {inProgress.length ? (
        <div style={groupStyle}>
          <MobileSectionLabel>In progress</MobileSectionLabel>
          <div style={stackStyle}>
            {inProgress.map(renderRow)}
          </div>
        </div>
      ) : null}

      {archived.length ? (
        <div style={groupStyle}>
          <MobileSectionLabel>Archived</MobileSectionLabel>
          <div style={stackStyle}>
            {archived.map(renderRow)}
          </div>
        </div>
      ) : null}

      {!orderedSessions.length ? (
        <p style={emptyStateStyle}>No remote sessions are available yet.</p>
      ) : null}
    </section>
  );
});
