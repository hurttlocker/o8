'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { SessionOperatorPanel } from '@/components/session-operator-panel';
import type { MobileControlAction, MobileInboxSnapshot } from '@/lib/mobile/types';

function pickCurrentSession(snapshot: MobileInboxSnapshot) {
  return snapshot.sessions.find((session) => session.isCurrentSession)
    ?? snapshot.sessions.find((session) => session.sessionKey === snapshot.primarySessionKey)
    ?? snapshot.sessions[0];
}

function statusClass(kind: MobileInboxSnapshot['summary'] extends never ? never : string) {
  switch (kind) {
    case 'critical':
      return 'status-critical';
    case 'warning':
      return 'status-warning';
    case 'success':
      return 'status-success';
    case 'info':
    default:
      return 'status-info';
  }
}

export function MobileRemoteShell({ initialSnapshot }: { initialSnapshot: MobileInboxSnapshot }) {
  const [snapshot, setSnapshot] = useState<MobileInboxSnapshot>(initialSnapshot);
  const [selectedId, setSelectedId] = useState(() => pickCurrentSession(initialSnapshot)?.id ?? '');
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [actionHint, setActionHint] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function refreshInbox() {
      try {
        const response = await fetch('/api/mobile/inbox', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const nextSnapshot = (await response.json()) as MobileInboxSnapshot;
        if (!active) return;
        setSnapshot(nextSnapshot);
        setRefreshError(null);
      } catch (error) {
        if (!active) return;
        setRefreshError(error instanceof Error ? error.message : 'Unable to refresh mobile inbox');
      }
    }

    refreshInbox();
    const timer = window.setInterval(refreshInbox, 30000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    setSelectedId((currentId) => {
      if (currentId && snapshot.sessions.some((session) => session.id === currentId)) {
        return currentId;
      }
      return pickCurrentSession(snapshot)?.id ?? '';
    });
  }, [snapshot]);

  const selectedSession = useMemo(
    () => snapshot.sessions.find((session) => session.id === selectedId) ?? pickCurrentSession(snapshot),
    [selectedId, snapshot],
  );

  function handleAction(action: MobileControlAction) {
    if (!action.available) {
      setActionHint(action.reasonUnavailable ?? 'That action is not wired yet on this adapter.');
      return;
    }

    if (!action.sessionKey) {
      setActionHint('Open the desktop review surface for the heavier action.');
      return;
    }

    const matchingSession = snapshot.sessions.find((session) => session.sessionKey === action.sessionKey);
    if (!matchingSession) {
      setActionHint('That session is no longer visible in the live mirror.');
      return;
    }

    setSelectedId(matchingSession.id);
    setActionHint(
      action.kind === 'steer'
        ? 'Session selected below. Use the operator panel to steer it.'
        : action.kind === 'stop'
          ? 'Session selected below. Use the operator panel to stop the active run.'
          : 'Session selected below. Use the operator panel for the live action.',
    );
  }

  return (
    <div className="mobile-wrap">
      <header className="surface-card mobile-header">
        <div>
          <div className="eyebrow">Cortex IDE Remote</div>
          <h1>Mobile control inbox</h1>
          <p className="muted">
            Phone stays operator-first: alerts, blockers, run watch, and review-ready awareness. Desktop stays
            the heavy execution surface.
          </p>
        </div>
        <Link href="/" className="inline-link">
          Back to desktop ↗
        </Link>
      </header>

      <section className="mobile-grid">
        <div className="surface-card mobile-card">
          <span>Mode</span>
          <strong>{snapshot.mode === 'live' ? 'Live control' : 'Demo fallback'}</strong>
          <p>{snapshot.note ?? 'Mobile is reading a control snapshot, not talking to one vendor runtime directly.'}</p>
        </div>
        <div className="surface-card mobile-card">
          <span>Primary session</span>
          <strong>{selectedSession?.name ?? 'Unknown'}</strong>
          <p>{selectedSession?.sessionKey ?? snapshot.primarySessionKey ?? 'No live session visible.'}</p>
        </div>
      </section>

      <section className="mobile-grid">
        <div className="surface-card mobile-card">
          <span>Active runs</span>
          <strong>{snapshot.summary.activeRuns}</strong>
          <p>Running, blocked, and review-warm sessions that may need attention tonight.</p>
        </div>
        <div className="surface-card mobile-card">
          <span>Alerts</span>
          <strong>{snapshot.summary.alerts}</strong>
          <p>Critical or warning items surfaced into the phone inbox instead of hiding in the desktop shell.</p>
        </div>
      </section>

      <section className="mobile-grid">
        <div className="surface-card mobile-card">
          <span>Approvals</span>
          <strong>{snapshot.summary.approvals}</strong>
          <p>Contract supports them; OpenClaw-backed approval handling is still a truthful future lane.</p>
        </div>
        <div className="surface-card mobile-card">
          <span>Review items</span>
          <strong>{snapshot.summary.reviewItems}</strong>
          <p>Desktop review stays heavy, but phone now knows when review-ready work exists.</p>
        </div>
      </section>

      <section className="surface-card">
        <div className="section-head">
          <div>
            <div className="eyebrow">Inbox</div>
            <h2>Live operator queue</h2>
          </div>
          <span className={`status-pill ${refreshError ? 'status-warning' : 'status-success'}`}>
            {refreshError ? 'refresh warning' : 'live inbox'}
          </span>
        </div>
        {actionHint ? <p className="muted operator-note">{actionHint}</p> : null}
        <div className="mobile-stack">
          {snapshot.items.map((item) => (
            <div key={item.id} className="mobile-action-card">
              <div className="row space-between compact-row">
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.detail}</p>
                </div>
                <span className={`status-pill ${statusClass(item.severity)}`}>{item.kind.replace('_', ' ')}</span>
              </div>
              <p className="muted mono">{item.timestampLabel ?? 'now'}</p>
              <div className="tool-drawer-list tool-drawer-list-mobile">
                {item.actions.map((action) => (
                  action.href ? (
                    <Link key={`${item.id}:${action.kind}`} href={action.href} className="mobile-action-link">
                      {action.label}
                    </Link>
                  ) : (
                    <button
                      key={`${item.id}:${action.kind}`}
                      type="button"
                      onClick={() => handleAction(action)}
                      disabled={!action.available}
                    >
                      {action.label}
                    </button>
                  )
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="surface-card">
        <div className="section-head">
          <div>
            <div className="eyebrow">Current session truth</div>
            <h2>Mirrored session first</h2>
          </div>
        </div>
        <div className="mobile-memory-card">
          <div>
            <strong>{selectedSession?.name ?? 'No current session'}</strong>
            <p className="muted">
              {selectedSession?.isCurrentSession
                ? 'This is the same Q ↔ Mister session you are actively talking in right now.'
                : 'The phone fell back to the freshest visible session from the live control snapshot.'}
            </p>
            <p className="muted mono">{selectedSession?.sessionKey ?? snapshot.primarySessionKey ?? 'unknown'}</p>
          </div>
          <button className="button-primary" type="button" onClick={() => setSelectedId(selectedSession?.id ?? '')}>
            Operate this session
          </button>
        </div>
      </section>

      {selectedSession ? <SessionOperatorPanel agent={selectedSession} compact /> : null}
    </div>
  );
}
