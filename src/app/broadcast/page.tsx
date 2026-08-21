'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

import { ThemeProvider } from '@/lib/theme/context';
import type { BroadcastEvent, BroadcastSnapshot } from '@/lib/broadcast/types';

import {
  BroadcastSidebar,
  type BroadcastConnectionState,
  EventFeed,
  StatusDot,
} from './BroadcastStage';

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

function mergeEvents(current: BroadcastEvent[], incoming: BroadcastEvent[]): BroadcastEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id))
    .slice(-FEED_LIMIT);
}

function BroadcastSurface() {
  const [token, setToken] = useState('');
  const [snapshot, setSnapshot] = useState<BroadcastSnapshot | null>(null);
  const [events, setEvents] = useState<BroadcastEvent[]>([]);
  const [state, setState] = useState<BroadcastConnectionState>('booting');
  const [isDocumentVisible, setIsDocumentVisible] = useState(true);
  const [isWide, setIsWide] = useState(false);
  const [compact, setCompact] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [reconnectPulse, setReconnectPulse] = useState(0);
  const cursorRef = useRef<string | null>(null);
  const wasOfflineRef = useRef(false);
  const reduceMotion = useReducedMotion() ?? false;

  useEffect(() => {
    const nextToken = readBootstrapToken();
    // This state transition intentionally happens in the mount effect. Hash
    // bootstrap must run while hidden and cannot depend on a paint callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToken(nextToken);
    setState(nextToken ? 'booting' : 'missing-token');
  }, []);

  useEffect(() => {
    const updateVisibility = () => setIsDocumentVisible(document.visibilityState === 'visible');
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  useEffect(() => {
    const updateLayout = () => {
      setIsWide(window.innerWidth >= 1_600);
      setCompact(new URLSearchParams(window.location.search).get('compact') === '1');
    };
    updateLayout();
    window.addEventListener('resize', updateLayout);
    window.addEventListener('popstate', updateLayout);
    return () => {
      window.removeEventListener('resize', updateLayout);
      window.removeEventListener('popstate', updateLayout);
    };
  }, []);

  useEffect(() => {
    if (!isDocumentVisible) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [isDocumentVisible]);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let stopped = false;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    const markLive = () => {
      if (wasOfflineRef.current) {
        wasOfflineRef.current = false;
        setReconnectPulse((current) => current + 1);
      }
      setState('live');
    };

    const markOffline = () => {
      wasOfflineRef.current = true;
      setState('offline');
    };

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
      markLive();
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
          markLive();
        } catch (error) {
          if (stopped || controller.signal.aborted) return;
          if (error instanceof Error && error.message === 'forbidden') {
            setState('forbidden');
            return;
          }
          markOffline();
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
              if (stopped) return;
              if (error instanceof Error && error.message === 'forbidden') setState('forbidden');
              else markOffline();
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
          markOffline();
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
        fontSize: 18,
        paddingTop: compact ? 18 : 28,
        paddingRight: 28,
        paddingBottom: 48,
        paddingLeft: 28,
      }}
    >
      <div style={{ width: '100%', maxWidth: 1880, minWidth: 0, marginRight: 'auto', marginLeft: 'auto' }}>
        {compact ? null : <header
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
                marginTop: 0,
                marginRight: 0,
                marginBottom: 0,
                marginLeft: 0,
                color: 'var(--t-text-strong)',
                fontSize: 28,
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
                fontSize: 18,
                fontWeight: 300,
                letterSpacing: '-0.1px',
                lineHeight: 1.35,
              }}
            >
              Live governed activity from the o8 ledger
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
            <motion.span
              key={reconnectPulse}
              initial={false}
              animate={reconnectPulse > 0 && !reduceMotion
                ? { opacity: [1, 0.55, 1], scale: [1, 1.04, 1] }
                : { opacity: 1, scale: 1 }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.55 }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                paddingTop: 7,
                paddingRight: 11,
                paddingBottom: 7,
                paddingLeft: 11,
                borderRadius: 14,
                background: 'var(--t-input-bg)',
                color: 'var(--t-text-secondary)',
                fontSize: 13,
                fontWeight: 300,
                letterSpacing: '0.04em',
                lineHeight: '18px',
              }}
            >
              <StatusDot filled={state === 'live'} />
              {statusCopy}
            </motion.span>
          </div>
        </header>
        }

        <div
          aria-label="Broadcast stage"
          style={{
            display: isWide ? 'grid' : 'flex',
            flexDirection: isWide ? undefined : 'column',
            gridTemplateColumns: isWide ? 'minmax(0, 3fr) minmax(0, 2fr)' : undefined,
            gridTemplateAreas: isWide ? "'stream sidebar'" : undefined,
            gap: isWide ? 24 : 16,
            minWidth: 0,
          }}
        >
          <BroadcastSidebar snapshot={snapshot} events={events} nowMs={nowMs} />
          <EventFeed
            events={events}
            lanes={snapshot?.lanes ?? []}
            state={state}
            nowMs={nowMs}
            reduceMotion={reduceMotion}
          />
        </div>
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
