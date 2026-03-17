/**
 * Desktop WebSocket hook — connects to WS server (port 3002).
 *
 * Receives all real-time data over a single connection:
 *   - chat deltas (streaming text)
 *   - inbox updates (agent status changes)
 *   - history updates (new transcript entries)
 *   - review updates (file changes → diff stats)
 *
 * Falls back gracefully if WS is unavailable.
 */

import { useEffect, useRef, useCallback, useState } from 'react';

export type WsConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

// Callbacks the consumer provides
export interface DesktopWsCallbacks {
  onChatDelta?: (text: string, runId: string) => void;
  onChatDone?: (text: string, runId: string) => void;
  onChatError?: (error: string) => void;
  onInboxUpdate?: (inbox: Record<string, unknown>) => void;
  onHistoryUpdate?: (sessionKey: string, entries: Array<Record<string, unknown>>) => void;
  onReviewUpdate?: (data: Record<string, unknown>) => void;
}

interface UseDesktopWebSocketResult {
  connectionState: WsConnectionState;
  isConnected: boolean;
  switchSession: (sessionKey: string) => void;
}

const MAX_BACKOFF = 30_000;
const INITIAL_BACKOFF = 1_000;
const PING_INTERVAL = 20_000;

function getWsUrl(): string {
  if (typeof window === 'undefined') return '';
  const { hostname, port, protocol } = window.location;
  const token = document.querySelector('meta[name="ws-token"]')?.getAttribute('content') ?? 'cortex-ide';
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  const wsProto = protocol === 'https:' ? 'wss' : 'ws';

  if (isLocal) {
    return `ws://${hostname}:3002/ws?token=${encodeURIComponent(token)}`;
  }
  const wsPort = port ? `:${port}` : '';
  return `${wsProto}://${hostname}${wsPort}/ws?token=${encodeURIComponent(token)}`;
}

export function useDesktopWebSocket(
  sessionKey: string | undefined,
  callbacks: DesktopWsCallbacks,
): UseDesktopWebSocketResult {
  const [connectionState, setConnectionState] = useState<WsConnectionState>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(INITIAL_BACKOFF);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const disposedRef = useRef(false);
  const sessionKeyRef = useRef(sessionKey);

  // Stable callback refs
  const cbRef = useRef(callbacks);
  useEffect(() => { cbRef.current = callbacks; }, [callbacks]);

  // Track session key
  useEffect(() => { sessionKeyRef.current = sessionKey; }, [sessionKey]);

  // Send session switch when key changes
  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN && sessionKey) {
      wsRef.current.send(JSON.stringify({ type: 'switch-session', sessionKey }));
    }
  }, [sessionKey]);

  // Imperative session switch
  const switchSession = useCallback((key: string) => {
    sessionKeyRef.current = key;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'switch-session', sessionKey: key }));
    }
  }, []);

  // Main connection — runs once
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
            backoffRef.current = INITIAL_BACKOFF;
          }
          break;

        case 'inbox':
          if (eventType === 'update' && data) {
            cbRef.current.onInboxUpdate?.(data);
          }
          break;

        case 'history':
          if (eventType === 'update' && data) {
            const sk = data.sessionKey as string;
            const entries = data.entries as Array<Record<string, unknown>>;
            if (sk && entries?.length > 0) {
              cbRef.current.onHistoryUpdate?.(sk, entries);
            }
          }
          break;

        case 'chat':
          if (eventType === 'delta' && data?.text) {
            cbRef.current.onChatDelta?.(data.text as string, (data.runId as string) ?? '');
          } else if (eventType === 'done') {
            cbRef.current.onChatDone?.((data?.text as string) ?? '', (data?.runId as string) ?? '');
          } else if (eventType === 'error') {
            cbRef.current.onChatError?.((data?.error as string) ?? 'Unknown error');
          }
          break;

        case 'review':
          if (eventType === 'update' && data) {
            cbRef.current.onReviewUpdate?.(data);
          }
          break;

        case 'pong':
          break;
      }
    }

    function connect() {
      if (disposedRef.current) return;
      setConnectionState(prev => prev === 'disconnected' ? 'connecting' : 'reconnecting');

      const ws = new WebSocket(url);

      ws.onopen = () => {
        if (disposedRef.current) { ws.close(); return; }
        wsRef.current = ws;
        if (sessionKeyRef.current) {
          ws.send(JSON.stringify({ type: 'subscribe', sessionKey: sessionKeyRef.current }));
        }
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
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            connect();
          }, backoffRef.current);
          backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF);
        }
      };

      ws.onerror = () => { /* onclose handles reconnect */ };
    }

    connect();

    return () => {
      disposedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      if (wsRef.current) wsRef.current.close();
      setConnectionState('disconnected');
    };
  }, []);

  return { connectionState, isConnected: connectionState === 'connected', switchSession };
}
