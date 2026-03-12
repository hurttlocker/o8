'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { demoFleet } from '@/lib/demo/fleet';
import type { FleetSnapshot } from '@/lib/fleet/types';
import { SessionOperatorPanel } from '@/components/session-operator-panel';

function pickCurrentSession(snapshot: FleetSnapshot) {
  return snapshot.agents.find((agent) => agent.isCurrentSession) ?? snapshot.agents[0];
}

export function MobileRemoteShell({ initialSnapshot }: { initialSnapshot: FleetSnapshot }) {
  const [fleet, setFleet] = useState<FleetSnapshot>(initialSnapshot);
  const [selectedId, setSelectedId] = useState(() => pickCurrentSession(initialSnapshot)?.id ?? '');
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function refreshLiveFleet() {
      try {
        const response = await fetch('/api/openclaw/fleet', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const nextSnapshot = (await response.json()) as FleetSnapshot;
        if (!active) return;
        setFleet(nextSnapshot);
        setRefreshError(null);
      } catch (error) {
        if (!active) return;
        setRefreshError(error instanceof Error ? error.message : 'Unable to refresh live fleet');
      }
    }

    refreshLiveFleet();
    const timer = window.setInterval(refreshLiveFleet, 30000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    setSelectedId((currentId) => {
      if (currentId && fleet.agents.some((agent) => agent.id === currentId)) {
        return currentId;
      }
      return pickCurrentSession(fleet)?.id ?? '';
    });
  }, [fleet]);

  const selectedSession = useMemo(
    () => fleet.agents.find((agent) => agent.id === selectedId) ?? pickCurrentSession(fleet) ?? pickCurrentSession(demoFleet),
    [fleet, selectedId],
  );
  const criticalItems = fleet.events.filter((event) => event.severity !== 'info');
  const pendingApprovals = fleet.agents.filter((agent) => agent.approvalStatus === 'pending');

  return (
    <div className="mobile-wrap">
      <header className="surface-card mobile-header">
        <div>
          <div className="eyebrow">Cortex IDE Remote</div>
          <h1>Phone-first operator surface</h1>
          <p className="muted">
            The first live mobile lane mirrors the current OpenClaw session and the hottest visible
            surfaces. New sessions should only appear after an explicit spawn action.
          </p>
        </div>
        <Link href="/" className="inline-link">
          Back to desktop ↗
        </Link>
      </header>

      <section className="mobile-grid">
        <div className="surface-card mobile-card">
          <span>Mode</span>
          <strong>{fleet.meta.mode === 'live' ? 'Live mirror' : 'Demo fallback'}</strong>
          <p>{fleet.meta.note}</p>
        </div>
        <div className="surface-card mobile-card">
          <span>Primary session</span>
          <strong>{selectedSession?.name ?? 'Unknown'}</strong>
          <p>{selectedSession?.sessionKey ?? 'No session key found.'}</p>
        </div>
      </section>

      <section className="mobile-grid">
        <div className="surface-card mobile-card">
          <span>Alerts</span>
          <strong>{criticalItems.length}</strong>
          <p>Blocked runs, stale sessions, and bridge warnings should be visible from the phone.</p>
        </div>
        <div className="surface-card mobile-card">
          <span>Approvals</span>
          <strong>{pendingApprovals.length}</strong>
          <p>Still placeholder-only until real approve / deny / steer actions are wired.</p>
        </div>
      </section>

      <section className="surface-card">
        <div className="section-head">
          <div>
            <div className="eyebrow">Inbox</div>
            <h2>Live mirrored sessions</h2>
          </div>
          <span className="status-pill status-warning">{refreshError ? 'refresh warning' : 'live preview'}</span>
        </div>
        <div className="mobile-stack">
          {fleet.agents.slice(0, 4).map((agent) => (
            <div key={agent.id} className="mobile-action-card">
              <div>
                <h3>{agent.name}</h3>
                <p>{agent.currentTask}</p>
                <p className="muted mono">{agent.sessionKey}</p>
              </div>
              <div className="tool-drawer-list tool-drawer-list-mobile">
                <button type="button" onClick={() => setSelectedId(agent.id)}>
                  {agent.id === selectedSession?.id ? 'Selected' : agent.isCurrentSession ? 'Open now' : 'Inspect'}
                </button>
                <button type="button" onClick={() => setSelectedId(agent.id)}>
                  Operate
                </button>
                <Link href="/" className="mobile-action-link">
                  Desktop ↗
                </Link>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="surface-card">
        <div className="section-head">
          <div>
            <div className="eyebrow">Context</div>
            <h2>Current session truth</h2>
          </div>
        </div>
        <div className="mobile-memory-card">
          <div>
            <strong>{selectedSession?.name ?? 'No current session'}</strong>
            <p className="muted">
              {selectedSession?.isCurrentSession
                ? 'This is the same Q ↔ Mister session you are actively talking in right now.'
                : 'The live bridge fell back to the freshest visible OpenClaw session.'}
            </p>
            <p className="muted mono">{fleet.meta.primarySessionKey ?? 'unknown'}</p>
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
