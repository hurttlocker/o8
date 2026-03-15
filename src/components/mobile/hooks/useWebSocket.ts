/**
 * Unified WebSocket hook for Cortex IDE mobile.
 *
 * Connects to the WS server (port 3002) and receives all real-time data
 * over a single connection. Falls back to polling if WS is unavailable.
 *
 * Channels received:
 *   system  — connection status
 *   inbox   — session list updates
 *   history — transcript updates
 *   chat    — streaming deltas
 *   pong    — keepalive
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type {
  MobileInboxSnapshot,
  MobileTranscriptEntry,
} from '@/lib/mobile/types';

export type WsConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

interface UseWebSocketArgs {
  selectedSessionKey?: string;
  setSnapshot: Dispatch<SetStateAction<MobileInboxSnapshot>>;
  setRefreshError: Dispatch<SetStateAction<string | null>>;
  setHistoryBySession: Dispatch<SetStateAction<Record<string, MobileTranscriptEntry[]>>>;
  setStreamingText: Dispatch<SetStateAction<string>>;
  streamingTextRef: MutableRefObject<string>;
}

interface UseWebSocketResult {
  connectionState: WsConnectionState;
  isConnected: boolean;
}

const MAX_BACKOFF = 30_000;
const INITIAL_BACKOFF = 1_000;
const PING_INTERVAL = 20_000;

function getWsUrl(): string {
  if (typeof window === 'undefined') return '';
  const { hostname, port, protocol } = window.location;
  // Auth token — prevents random network clients from connecting
  const token = document.querySelector('meta[name="ws-token"]')?.getAttribute('content') ?? 'cortex-ide';

  // When accessed via Tailscale / remote, use same-origin (proxied through
  // Next.js rewrites on /ws). For local dev on localhost, fall back to the
  // direct WS server port so hot-reload doesn't need the proxy running.
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  const wsProto = protocol === 'https:' ? 'wss' : 'ws';

  if (isLocal) {
    return `ws://${hostname}:3002/ws?token=${encodeURIComponent(token)}`;
  }
  // Remote: connect through the same host:port as the page (Next.js proxies /ws → 3002)
  const wsPort = port ? `:${port}` : '';
  return `${wsProto}://${hostname}${wsPort}/ws?token=${encodeURIComponent(token)}`;
}

export function useWebSocket({
  selectedSessionKey,
  setSnapshot,
  setRefreshError,
  setHistoryBySession,
  setStreamingText,
  streamingTextRef,
}: UseWebSocketArgs): UseWebSocketResult {
  const [connectionState, setConnectionState] = useState<WsConnectionState>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(INITIAL_BACKOFF);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const disposedRef = useRef(false);
  const sessionKeyRef = useRef(selectedSessionKey);

  // Stable refs for state setters so the connection effect never re-fires
  const setSnapshotRef = useRef(setSnapshot);
  const setRefreshErrorRef = useRef(setRefreshError);
  const setHistoryBySessionRef = useRef(setHistoryBySession);
  const setStreamingTextRef = useRef(setStreamingText);
  const streamingTextRefRef = useRef(streamingTextRef);

  useEffect(() => { setSnapshotRef.current = setSnapshot; }, [setSnapshot]);
  useEffect(() => { setRefreshErrorRef.current = setRefreshError; }, [setRefreshError]);
  useEffect(() => { setHistoryBySessionRef.current = setHistoryBySession; }, [setHistoryBySession]);
  useEffect(() => { setStreamingTextRef.current = setStreamingText; }, [setStreamingText]);
  useEffect(() => { streamingTextRefRef.current = streamingTextRef; }, [streamingTextRef]);

  // Keep session key ref current
  useEffect(() => {
    sessionKeyRef.current = selectedSessionKey;
  }, [selectedSessionKey]);

  // Send session switch when selected session changes
  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN && selectedSessionKey) {
      wsRef.current.send(JSON.stringify({ type: 'switch-session', sessionKey: selectedSessionKey }));
    }
  }, [selectedSessionKey]);

  // Main connection effect — runs once on mount, never re-fires
  useEffect(() => {
    disposedRef.current = false;
    const url = getWsUrl();
    if (!url) return;

    function handleMessage(event: MessageEvent) {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : ''); } catch { return; }

      const channel = msg.channel as string;
      const eventType = msg.event as string;
      const data = msg.data as Record<string, unknown> | undefined;

      switch (channel) {
        case 'system':
          if (eventType === 'connected') {
            setConnectionState('connected');
            setRefreshErrorRef.current(null);
            backoffRef.current = INITIAL_BACKOFF;
          }
          break;

        case 'inbox':
          if (eventType === 'update' && data) {
            const inbox = data as unknown as MobileInboxSnapshot;
            setSnapshotRef.current((prev) => {
              const prevKey = prev.sessions.map((s) =>
                `${s.sessionKey}:${s.status}:${Math.round(s.context?.usedPercent ?? 0)}`
              ).join('|');
              const nextKey = inbox.sessions.map((s) =>
                `${s.sessionKey}:${s.status}:${Math.round(s.context?.usedPercent ?? 0)}`
              ).join('|');
              if (prevKey === nextKey && prev.summary.alerts === inbox.summary.alerts) return prev;
              return inbox;
            });
          }
          break;

        case 'history':
          if (eventType === 'update' && data) {
            const { sessionKey, entries } = data as { sessionKey: string; entries: MobileTranscriptEntry[] };
            if (entries?.length > 0) {
              setHistoryBySessionRef.current((current) => {
                const prev = current[sessionKey] ?? [];
                const existingIds = new Set(prev.map((e) => e.id));
                const genuinelyNew = entries.filter((e) => !existingIds.has(e.id));
                if (genuinelyNew.length === 0) return current;
                return { ...current, [sessionKey]: [...prev, ...genuinelyNew] };
              });
            }
          }
          break;

        case 'chat':
          if (eventType === 'delta' && data?.text) {
            streamingTextRefRef.current.current = data.text as string;
            setStreamingTextRef.current(data.text as string);
          } else if (eventType === 'done') {
            const doneText = (data?.text as string) ?? '';
            streamingTextRefRef.current.current = '';
            setStreamingTextRef.current('');
            // Inject final message into history
            if (doneText && sessionKeyRef.current) {
              const sk = sessionKeyRef.current;
              setHistoryBySessionRef.current((current) => {
                const prev = current[sk] ?? [];
                if (prev.length > 0 && prev[prev.length - 1]?.text === doneText) return current;
                const entry: MobileTranscriptEntry = {
                  id: `stream:${(data?.runId as string) ?? Date.now()}`,
                  role: 'assistant',
                  text: doneText,
                  timestampLabel: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
                };
                return { ...current, [sk]: [...prev, entry] };
              });
            }
          } else if (eventType === 'error') {
            streamingTextRefRef.current.current = '';
            setStreamingTextRef.current('');
          }
          break;

        case 'pong':
          // Keepalive acknowledged
          break;
      }
    }

    function connect() {
      if (disposedRef.current) return;
      setConnectionState((prev) => prev === 'disconnected' ? 'connecting' : 'reconnecting');

      const ws = new WebSocket(url);

      ws.onopen = () => {
        if (disposedRef.current) { ws.close(); return; }
        wsRef.current = ws;
        // Subscribe to current session
        if (sessionKeyRef.current) {
          ws.send(JSON.stringify({ type: 'subscribe', sessionKey: sessionKeyRef.current }));
        }
        // Start keepalive
        pingTimerRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, PING_INTERVAL);
      };

      ws.onmessage = handleMessage;

      ws.onclose = () => {
        wsRef.current = null;
        if (pingTimerRef.current) { clearInterval(pingTimerRef.current); pingTimerRef.current = null; }
        if (!disposedRef.current) {
          setConnectionState('reconnecting');
          streamingTextRefRef.current.current = '';
          setStreamingTextRef.current('');
          // Exponential backoff reconnect
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            connect();
          }, backoffRef.current);
          backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF);
        }
      };

      ws.onerror = () => {
        // onclose will fire after this
      };
    }

    connect();

    return () => {
      disposedRef.current = true;
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      if (pingTimerRef.current) { clearInterval(pingTimerRef.current); pingTimerRef.current = null; }
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
      setConnectionState('disconnected');
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- stable refs used internally

  return {
    connectionState,
    isConnected: connectionState === 'connected',
  };
}
