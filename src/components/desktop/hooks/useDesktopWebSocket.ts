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
  // Terminal channel
  onTerminalCreated?: (sessionName: string) => void;
  onTerminalData?: (sessionName: string, data: string) => void;
  onTerminalAttached?: (sessionName: string) => void;
  onTerminalExited?: (sessionName: string, exitCode: number) => void;
  onTerminalError?: (sessionName: string, error: string) => void;
  onTerminalImage?: (sessionName: string, iip: string) => void;
}

interface UseDesktopWebSocketResult {
  connectionState: WsConnectionState;
  isConnected: boolean;
  switchSession: (sessionKey: string) => void;
  sendTerminalCreate: (cols: number, rows: number) => void;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
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

  // Terminal commands
  const sendTerminalCreate = useCallback((cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'terminal-create', cols, rows }));
    }
  }, []);

  const sendTerminalAttach = useCallback((sessionName: string, cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'terminal-attach', sessionName, cols, rows }));
    }
  }, []);

  const sendTerminalInput = useCallback((sessionName: string, data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'terminal-input', sessionName, data }));
    }
  }, []);

  const sendTerminalResize = useCallback((sessionName: string, cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'terminal-resize', sessionName, cols, rows }));
    }
  }, []);

  const sendTerminalDetach = useCallback((sessionName: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'terminal-detach', sessionName }));
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
          if (data) {
            cbRef.current.onReviewUpdate?.({ event: eventType, ...data });
          }
          break;

        case 'terminal':
          if (eventType === 'created' && data) {
            cbRef.current.onTerminalCreated?.(data.sessionName as string);
          } else if (eventType === 'data' && data) {
            cbRef.current.onTerminalData?.(data.sessionName as string, data.data as string);
          } else if (eventType === 'attached' && data) {
            cbRef.current.onTerminalAttached?.(data.sessionName as string);
          } else if (eventType === 'exited' && data) {
            cbRef.current.onTerminalExited?.(data.sessionName as string, (data.exitCode as number) ?? 0);
          } else if (eventType === 'error' && data) {
            cbRef.current.onTerminalError?.(data.sessionName as string, (data.error as string) ?? 'Unknown error');
          } else if (eventType === 'image' && data) {
            // Build IIP escape sequence from raw components (avoids JSON escape mangling)
            const filenameB64 = data.filenameB64 as string;
            const fileSize = data.fileSize as number;
            const imageB64 = data.imageB64 as string;
            // width=auto;height=auto tells the addon to size based on pixel dimensions
            // preserveAspectRatio=1 keeps proportions correct
            const iip = `\x1b]1337;File=name=${filenameB64};size=${fileSize};width=auto;height=auto;inline=1;preserveAspectRatio=1:${imageB64}\x07`;
            cbRef.current.onTerminalImage?.(data.sessionName as string, iip);
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

  return {
    connectionState,
    isConnected: connectionState === 'connected',
    switchSession,
    sendTerminalCreate,
    sendTerminalAttach,
    sendTerminalInput,
    sendTerminalResize,
    sendTerminalDetach,
  };
}
