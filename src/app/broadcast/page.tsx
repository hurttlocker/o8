'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { ThemeProvider } from '@/lib/theme/context';
import type {
  BroadcastAgentSnapshot,
  BroadcastEvent,
  BroadcastSnapshot,
} from '@/lib/broadcast/types';

const TOKEN_STORAGE_KEY = 'o8.broadcast.spectator-token';
const SNAPSHOT_REFRESH_MS = 10_000;
const FEED_LIMIT = 250;

function readBootstrapToken(): string {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const incoming = fragment.get('token')?.trim() ?? '';
  if (incoming) {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, incoming);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    return incoming;
  }
  return window.sessionStorage.getItem(TOKEN_STORAGE_KEY)?.trim() ?? '';
}

function formatTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(parsed);
}

function kindLabel(kind: string): string {
  return kind.replaceAll('_', ' ').toUpperCase();
}

function mergeEvents(current: BroadcastEvent[], incoming: BroadcastEvent[]): BroadcastEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id))
    .slice(-FEED_LIMIT);
}

function eventDotIsFilled(kind: BroadcastEvent['kind']): boolean {
  return kind === 'session_launched'
    || kind === 'progress'
    || kind === 'brain_consulted'
    || kind === 'lease_acquired'
    || kind === 'approval'
    || kind === 'message';
}

function StatusDot({ filled, size = 6 }: { filled: boolean; size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        minWidth: size,
        borderRadius: '50%',
        border: '1px solid var(--t-accent)',
        background: filled ? 'var(--t-accent)' : 'transparent',
        boxSizing: 'border-box',
        display: 'inline-block',
      }}
    />
  );
}

function OnAirStrip({ agents }: { agents: BroadcastAgentSnapshot[] }) {
  return (
    <section
      aria-label="Agents on air"
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 12,
        minWidth: 0,
        paddingTop: 12,
        paddingRight: 14,
        paddingBottom: 12,
        paddingLeft: 14,
        border: '1px solid var(--t-panel-border)',
        borderRadius: 12,
        background: 'var(--t-panel)',
      }}
    >
      <span
        style={{
          color: 'var(--t-text-faint)',
          fontSize: 9,
          fontWeight: 300,
          letterSpacing: '0.04em',
          lineHeight: '14px',
        }}
      >
        ON AIR
      </span>
      {agents.length === 0 ? (
        <span style={{ color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300 }}>
          No agents running
        </span>
      ) : agents.map((agent) => (
        <span
          key={agent.laneId}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            minWidth: 0,
            color: 'var(--t-text-secondary)',
            fontSize: 11,
            fontWeight: 300,
            letterSpacing: '-0.1px',
          }}
        >
          <StatusDot filled />
          <span style={{ overflowWrap: 'anywhere' }}>{agent.label}</span>
          <span style={{ color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260 }}>
            {agent.repo} · {agent.status}
          </span>
        </span>
      ))}
    </section>
  );
}

function EventRow({ event }: { event: BroadcastEvent }) {
  return (
    <article
      style={{
        display: 'grid',
        gridTemplateColumns: '12px minmax(0, 1fr) auto',
        columnGap: 10,
        alignItems: 'start',
        minWidth: 0,
        paddingTop: 12,
        paddingRight: 12,
        paddingBottom: 12,
        paddingLeft: 12,
        borderBottom: '1px solid var(--t-divider-subtle)',
      }}
    >
      <span style={{ paddingTop: 5, display: 'flex', justifyContent: 'center' }}>
        <StatusDot filled={eventDotIsFilled(event.kind)} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            color: 'var(--t-text)',
            fontSize: 13.5,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            lineHeight: 1.25,
            overflowWrap: 'anywhere',
          }}
        >
          {event.title}
        </div>
        {event.detail ? (
          <div
            style={{
              marginTop: 4,
              color: 'var(--t-text-secondary)',
              fontSize: 13,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              lineHeight: 1.5,
              overflowWrap: 'anywhere',
              whiteSpace: 'pre-wrap',
            }}
          >
            {event.detail}
          </div>
        ) : null}
        <div
          style={{
            marginTop: 4,
            color: 'var(--t-text-faint)',
            fontSize: 9.5,
            fontWeight: 260,
            letterSpacing: '-0.4px',
            lineHeight: 1.25,
            overflowWrap: 'anywhere',
          }}
        >
          {kindLabel(event.kind)}{event.repo ? ` · ${event.repo}` : ''}{event.actor ? ` · ${event.actor}` : ''}
        </div>
      </div>
      <time
        dateTime={event.timestamp}
        style={{
          color: 'var(--t-text-faint)',
          fontSize: 9.5,
          fontWeight: 260,
          letterSpacing: '-0.4px',
          lineHeight: 1.25,
          whiteSpace: 'nowrap',
        }}
      >
        {formatTime(event.timestamp)}
      </time>
    </article>
  );
}

function BroadcastSurface() {
  const [token, setToken] = useState('');
  const [snapshot, setSnapshot] = useState<BroadcastSnapshot | null>(null);
  const [events, setEvents] = useState<BroadcastEvent[]>([]);
  const [state, setState] = useState<'booting' | 'live' | 'missing-token' | 'forbidden' | 'offline'>('booting');
  const [isDocumentVisible, setIsDocumentVisible] = useState(true);
  const cursorRef = useRef<string | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const nextToken = readBootstrapToken();
      setToken(nextToken);
      setState(nextToken ? 'booting' : 'missing-token');
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const updateVisibility = () => setIsDocumentVisible(document.visibilityState === 'visible');
    const frame = window.requestAnimationFrame(updateVisibility);
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, []);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let stopped = false;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    const request = async <T,>(route: string): Promise<T> => {
      const response = await fetch(route, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) throw new Error('forbidden');
      if (!response.ok) throw new Error(`Broadcast request failed with ${response.status}.`);
      return response.json() as Promise<T>;
    };

    const refreshSnapshot = async (initialize: boolean) => {
      const next = await request<BroadcastSnapshot>('/api/broadcast/snapshot?events=40');
      if (stopped) return;
      setSnapshot(next);
      if (initialize) {
        setEvents(next.recentEvents);
        cursorRef.current = next.cursor;
      }
      setState('live');
    };

    const poll = async () => {
      while (!stopped) {
        try {
          const params = new URLSearchParams({ wait: '25000', limit: '50' });
          if (cursorRef.current) params.set('cursor', cursorRef.current);
          const page = await request<{
            events: BroadcastEvent[];
            cursor: string | null;
          }>(`/api/broadcast/events?${params.toString()}`);
          if (stopped) return;
          cursorRef.current = page.cursor;
          if (page.events.length) setEvents((current) => mergeEvents(current, page.events));
          setState('live');
        } catch (error) {
          if (stopped || controller.signal.aborted) return;
          if (error instanceof Error && error.message === 'forbidden') {
            setState('forbidden');
            return;
          }
          setState('offline');
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
    };

    const connect = async () => {
      while (!stopped) {
        try {
          await refreshSnapshot(true);
          if (stopped) return;
          // A hidden page (background tab, inactive OBS scene) still paints the
          // latest snapshot once; the long-poll and refresh loop only run while
          // visible, and the effect re-runs on the next visibilitychange.
          if (!isDocumentVisible) return;
          refreshTimer = setInterval(() => {
            void refreshSnapshot(false).catch((error) => {
              if (!stopped && error instanceof Error && error.message === 'forbidden') setState('forbidden');
            });
          }, SNAPSHOT_REFRESH_MS);
          void poll();
          return;
        } catch (error) {
          if (stopped || controller.signal.aborted) return;
          if (error instanceof Error && error.message === 'forbidden') {
            setState('forbidden');
            return;
          }
          setState('offline');
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
    };

    void connect();

    return () => {
      stopped = true;
      controller.abort();
      if (refreshTimer) clearInterval(refreshTimer);
    };
  }, [isDocumentVisible, token]);

  const visibleEvents = useMemo(() => [...events].reverse(), [events]);
  const statusCopy = state === 'live'
    ? 'LIVE'
    : state === 'booting' ? 'CONNECTING'
      : state === 'missing-token' ? 'TOKEN REQUIRED'
        : state === 'forbidden' ? 'ACCESS REVOKED' : 'RECONNECTING';

  return (
    <main
      style={{
        boxSizing: 'border-box',
        width: '100%',
        minHeight: '100dvh',
        overflowX: 'hidden',
        background: 'var(--t-bg-gradient)',
        color: 'var(--t-text)',
        fontFamily: 'var(--font-sans-system)',
        paddingTop: 28,
        paddingRight: 28,
        paddingBottom: 48,
        paddingLeft: 28,
      }}
    >
      <div style={{ width: '100%', maxWidth: 1040, minWidth: 0, marginRight: 'auto', marginLeft: 'auto' }}>
        <header
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 16,
            minWidth: 0,
            marginBottom: 16,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <h1
              style={{
                margin: 0,
                color: 'var(--t-text-strong)',
                fontSize: 18,
                fontWeight: 400,
                letterSpacing: '-0.2px',
                lineHeight: 1.25,
              }}
            >
              Broadcast
            </h1>
            <p
              style={{
                marginTop: 4,
                marginRight: 0,
                marginBottom: 0,
                marginLeft: 0,
                color: 'var(--t-text-muted)',
                fontSize: 11,
                fontWeight: 300,
                letterSpacing: '-0.1px',
                lineHeight: 1.35,
              }}
            >
              Live governed activity from the o8 ledger
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span style={{ color: 'var(--t-text-secondary)', fontSize: 11, fontWeight: 300 }}>
              {snapshot?.pendingApprovals.count ?? 0} pending approvals
            </span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                color: 'var(--t-text-secondary)',
                fontSize: 9,
                fontWeight: 300,
                letterSpacing: '0.04em',
                lineHeight: '14px',
              }}
            >
              <StatusDot filled={state === 'live'} />
              {statusCopy}
            </span>
          </div>
        </header>

        <OnAirStrip agents={snapshot?.activeAgents ?? []} />

        <section
          aria-label="Broadcast event feed"
          aria-live="polite"
          style={{
            minWidth: 0,
            marginTop: 16,
            border: '1px solid var(--t-panel-border)',
            borderRadius: 12,
            background: 'var(--t-panel)',
            overflowX: 'hidden',
          }}
        >
          <div
            style={{
              paddingTop: 11,
              paddingRight: 12,
              paddingBottom: 10,
              paddingLeft: 12,
              borderBottom: '1px solid var(--t-divider-subtle)',
              color: 'var(--t-text-faint)',
              fontSize: 9,
              fontWeight: 300,
              letterSpacing: '0.04em',
              lineHeight: '14px',
            }}
          >
            EVENT STREAM
          </div>
          {visibleEvents.length ? visibleEvents.map((event) => (
            <EventRow key={event.id} event={event} />
          )) : (
            <div
              style={{
                paddingTop: 28,
                paddingRight: 20,
                paddingBottom: 28,
                paddingLeft: 20,
                color: 'var(--t-text-muted)',
                fontSize: 13,
                fontWeight: 300,
                lineHeight: 1.5,
                textAlign: 'center',
                overflowWrap: 'anywhere',
              }}
            >
              {state === 'missing-token'
                ? 'Open the spectator URL returned by o8 broadcast token mint.'
                : state === 'forbidden'
                  ? 'This spectator credential is no longer authorized.'
                  : 'Waiting for governed activity.'}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

export default function BroadcastPage() {
  return (
    <ThemeProvider>
      <BroadcastSurface />
    </ThemeProvider>
  );
}
