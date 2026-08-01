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
import { deriveManagedRunLabel } from '@/lib/runtimes/managed-runs/labels';
import { DEGRADED_FALLBACK_REFRESH_MS, REALTIME_FALLBACK_REFRESH_MS, startDurableRefresh } from '@/lib/panel/durable-refresh';
import { ShimmerLine, TURN_LINE_FONT_SIZE } from '../thoughts/chat-panel/turn-line';
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
    const fetchRuns = async () => {
      try {
        const response = await fetch('/api/panel/managed-runs');
        const data = await response.json() as { runs?: ManagedRun[] };
        if (cancelled) return;
        setRuns((data.runs ?? []).filter((run) => run.status === 'running'));
      } catch {
        // The lifecycle event or fallback timer will repair a transient miss.
      }
    };
    void fetchRuns();

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
    // down we use a one-minute recovery cadence rather than wait five minutes.
    const stopDurableRefresh = startDurableRefresh({
      refresh: fetchRuns,
      intervalMs: wsConnected ? REALTIME_FALLBACK_REFRESH_MS : DEGRADED_FALLBACK_REFRESH_MS,
      events: ['o8:lifecycle-reconcile'],
    });
    return () => {
      cancelled = true;
      stopDurableRefresh();
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

  // Slim-line grammar (2026-07-13 redesign): live runs render as shimmering
  // TEXT LINES in the turn vocabulary — no boxed pills, no accent chrome, no
  // uppercase chip. Click the line to watch the live terminal; a small stop
  // square reveals on hover only.
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 6,
        paddingRight: 14,
        paddingBottom: 6,
        paddingLeft: 14,
        // Transparent — the OrchestratorTab root paints the chat surface +
        // glass top-glow as ONE field; an opaque strip here occluded the
        // glow and read as a darker bar on dark glass (Q report 2026-07-14).
        background: 'transparent',
        flexShrink: 0,
      }}
    >
      {runs.map((run) => (
        <div
          key={run.session}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minHeight: 22,
            minWidth: 0,
          }}
          onMouseEnter={(e) => {
            const stopBtn = e.currentTarget.querySelector('[data-run-stop]') as HTMLElement | null;
            if (stopBtn) stopBtn.style.opacity = '1';
          }}
          onMouseLeave={(e) => {
            const stopBtn = e.currentTarget.querySelector('[data-run-stop]') as HTMLElement | null;
            if (stopBtn) stopBtn.style.opacity = '0';
          }}
        >
          <button
            type="button"
            onClick={() => watch(run)}
            title={`Watch the live terminal: ${run.command}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              minWidth: 0,
              paddingTop: 0,
              paddingRight: 0,
              paddingBottom: 0,
              paddingLeft: 0,
              borderWidth: 0,
              background: 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: 'var(--font-sans-system)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
            onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
          >
            <ShimmerLine>
              {'Running '}
              <span style={{ fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: TURN_LINE_FONT_SIZE - 1 }}>
                {deriveManagedRunLabel(run)}
              </span>
            </ShimmerLine>
          </button>
          <button
            type="button"
            data-run-stop=""
            onClick={() => stop(run.session)}
            title={`Stop run: ${run.command}`}
            aria-label="Stop run"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 18,
              height: 18,
              flexShrink: 0,
              paddingTop: 0,
              paddingRight: 0,
              paddingBottom: 0,
              paddingLeft: 0,
              borderWidth: 0,
              borderRadius: 5,
              background: 'transparent',
              color: 'var(--t-text-muted)',
              cursor: 'pointer',
              opacity: 0,
              transition: 'opacity 120ms ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--t-danger)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--t-text-muted)'; }}
          >
            <svg width={8} height={8} viewBox="0 0 24 24" style={{ display: 'block' }} aria-hidden="true">
              <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
