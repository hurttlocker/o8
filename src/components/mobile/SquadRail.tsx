import { memo, useMemo } from 'react';
import { Monitor } from 'lucide-react';
import type { SessionSummary, SquadRailProps } from './types';
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

export const SquadRail = memo(function SquadRail({
  snapshot,
  selectedSession,
  onSessionFocus,
  compactLine,
}: SquadRailProps) {
  const orderedSessions = useMemo(
    () => [...snapshot.sessions].sort((left, right) => (
      sessionPriority(right, selectedSession) - sessionPriority(left, selectedSession)
    )),
    [selectedSession, snapshot.sessions],
  );

  const inProgress = orderedSessions.filter((session) => isInProgress(session, selectedSession));
  const archived = orderedSessions.filter((session) => !isInProgress(session, selectedSession));

  const renderRow = (session: SessionSummary) => (
    <MobileListRow
      key={session.id}
      title={compactLine(session.currentTask ?? session.name, session.name ?? session.sessionKey, 56)}
      subtitle="Remote control"
      selected={session.id === selectedSession?.id}
      leadingIcon={<Monitor size={13} strokeWidth={1.9} />}
      onClick={() => onSessionFocus(session.id)}
    />
  );

  return (
    <section className="remodex-reference-list-screen">
      {inProgress.length ? (
        <div className="remodex-reference-list-group">
          <MobileSectionLabel>In progress</MobileSectionLabel>
          <div className="remodex-reference-list-stack">
            {inProgress.map(renderRow)}
          </div>
        </div>
      ) : null}

      {archived.length ? (
        <div className="remodex-reference-list-group">
          <MobileSectionLabel>Archived</MobileSectionLabel>
          <div className="remodex-reference-list-stack">
            {archived.map(renderRow)}
          </div>
        </div>
      ) : null}

      {!orderedSessions.length ? (
        <p className="remodex-reference-empty-copy">No remote sessions are available yet.</p>
      ) : null}
    </section>
  );
});
