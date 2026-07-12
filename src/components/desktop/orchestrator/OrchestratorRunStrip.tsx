'use client';

/**
 * OrchestratorRunStrip — a slim "watch live" strip at the top of the
 * orchestrator chat. When agents (or the operator) have live `o8 run`
 * sessions, each surfaces here as a chip; clicking it fires
 * `o8:open-agent-terminal` so the live read-only terminal opens in the bottom
 * panel — the operator watches the raw stdout without leaving the chat.
 *
 * Hidden (zero chrome) when no run is active. Polls /api/panel/managed-runs
 * (cheap, in-process) and refreshes on agent-lifecycle events.
 */

import { useEffect, useState } from 'react';
import { Terminal as TerminalIcon } from 'iconoir-react';
import { deriveManagedRunLabel } from '@/lib/runtimes/managed-runs/labels';
import { useWsConnectionState } from '../hooks/DesktopWebSocketContext';

interface ManagedRun {
  id: string;
  session: string;
  command: string;
  title?: string | null;
  startedAt?: string | null;
  status: 'running' | 'finished' | 'gone';
}

export function OrchestratorRunStrip({ active }: { active: boolean }) {
  const [runs, setRuns] = useState<ManagedRun[]>([]);
  const wsConnected = useWsConnectionState() === 'connected';

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const fetchRuns = () => {
      fetch('/api/panel/managed-runs')
        .then((r) => r.json())
        .then((data: { runs?: ManagedRun[] }) => {
          if (cancelled) return;
          setRuns((data.runs ?? []).filter((r) => r.status === 'running'));
        })
        .catch(() => {});
    };
    fetchRuns();
    const handler = () => fetchRuns();
    window.addEventListener('o8:agent-lifecycle', handler);

    // PERF: this strip renders NOTHING when no run is active, yet it polled every
    // 8s to find out whether one had started — the busiest idle endpoint after
    // the spec pane. It could not gate on visibility, because its visibility is
    // what the poll determines.
    //
    // The real problem was a missing wire: the ws-server has always broadcast
    // agent-lifecycle, but nothing bridged it to the window event this listener
    // is already waiting on, so the poll WAS the signal. That bridge now exists
    // (DesktopWebSocketContext), so a run starting or stopping anywhere — CLI, an
    // agent, another surface — reaches us immediately instead of up to 8s later.
    //
    // The interval is therefore a safety net, not the signal. When the socket is
    // down we genuinely have no signal, so we fall back to the old cadence rather
    // than go blind.
    const timer = setInterval(fetchRuns, wsConnected ? 60_000 : 8_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('o8:agent-lifecycle', handler);
    };
    // wsConnected in deps: reconnecting re-establishes the slow cadence AND
    // refetches immediately, resyncing anything missed while the socket was down.
  }, [active, wsConnected]);

  if (runs.length === 0) return null;

  const watch = (run: ManagedRun) => {
    window.dispatchEvent(new CustomEvent('o8:open-agent-terminal', {
      detail: { session: run.session, label: deriveManagedRunLabel(run), command: run.command },
    }));
  };

  const stop = (session: string) => {
    setRuns((prev) => prev.filter((r) => r.session !== session));
    fetch('/api/panel/managed-runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'kill', session }),
    })
      .catch(() => {})
      .finally(() => window.dispatchEvent(new Event('o8:agent-lifecycle')));
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        paddingTop: 7,
        paddingRight: 14,
        paddingBottom: 7,
        paddingLeft: 14,
        borderBottomWidth: '0.5px',
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        background: 'var(--t-chat-surface-bg, #ffffff)',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
          color: 'var(--t-text-faint)',
          flexShrink: 0,
        }}
      >
        Running
      </span>
      {runs.map((run) => (
        <span
          key={run.session}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            height: 24,
            borderRadius: 7,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-accent-border)',
            background: 'var(--t-accent-soft)',
            maxWidth: 340,
            flexShrink: 0,
            overflow: 'hidden',
          }}
        >
          <button
            type="button"
            onClick={() => watch(run)}
            title={`Watch the live terminal: ${run.command}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: '100%',
              paddingTop: 0,
              paddingRight: 8,
              paddingBottom: 0,
              paddingLeft: 8,
              borderWidth: 0,
              background: 'transparent',
              color: 'var(--t-accent)',
              cursor: 'pointer',
              fontSize: 11.5,
              fontWeight: 500,
              letterSpacing: '-0.005em',
              fontFamily: 'var(--font-sans-system)',
              minWidth: 0,
            }}
          >
            <TerminalIcon width={12} height={12} color="var(--t-accent)" strokeWidth={2} style={{ flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {deriveManagedRunLabel(run)}
            </span>
          </button>
          <button
            type="button"
            onClick={() => stop(run.session)}
            title={`Stop run: ${run.command}`}
            aria-label="Stop run"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 22,
              height: '100%',
              flexShrink: 0,
              borderWidth: 0,
              borderLeftWidth: 1,
              borderLeftStyle: 'solid',
              borderLeftColor: 'var(--t-accent-border)',
              background: 'transparent',
              color: 'var(--t-accent)',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-danger-soft, var(--t-accent-soft-strong))'; e.currentTarget.style.color = 'var(--t-danger)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--t-accent)'; }}
          >
            <svg width={8} height={8} viewBox="0 0 24 24" style={{ display: 'block' }} aria-hidden="true">
              <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
            </svg>
          </button>
        </span>
      ))}
    </div>
  );
}
