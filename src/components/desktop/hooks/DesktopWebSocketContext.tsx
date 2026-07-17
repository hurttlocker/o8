/**
 * Shared desktop WebSocket context — one connection per dashboard page.
 *
 * Components subscribe to channels by registering callbacks via
 * useSharedDesktopWs(). The provider owns the single WS connection and
 * fans out incoming messages to all registered listeners.
 *
 * This replaces the per-component useDesktopWebSocket() pattern that was
 * opening 5 separate connections from the dashboard.
 */

'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import type { DesktopWsCallbacks } from './useDesktopWebSocket';
import type { RealtimeEventEnvelope, RealtimeSubscription } from '@/lib/realtime/types';
import { getBrowserWsPort } from '@/lib/panel/ws-port-client';

export type WsConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

const MAX_BACKOFF = 30_000;
const INITIAL_BACKOFF = 1_000;
const PING_INTERVAL = 20_000;

function getWsUrl(): string {
  if (typeof window === 'undefined') return '';
  const { hostname, port, protocol } = window.location;
  const token = document.querySelector('meta[name="ws-token"]')?.getAttribute('content') ?? '';
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  const wsProto = protocol === 'https:' ? 'wss' : 'ws';
  if (isLocal) {
    return `ws://${hostname}:${getBrowserWsPort()}/ws?token=${encodeURIComponent(token)}`;
  }
  const wsPort = port ? `:${port}` : '';
  return `${wsProto}://${hostname}${wsPort}/ws?token=${encodeURIComponent(token)}`;
}

// ── Imperative methods exposed by the shared connection ──

interface SharedWsCommands {
  switchSession: (sessionKey: string) => void;
  sendTerminalCreate: (cols: number, rows: number, requestId?: string) => void;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
  sendAgentKill: (sessionName: string, signal?: 'SIGTERM' | 'SIGINT') => void;
}

interface SharedWsState {
  connectionState: WsConnectionState;
  isConnected: boolean;
}

type ListenerId = number;

interface SharedWsContextValue extends SharedWsState, SharedWsCommands {
  /** Register a set of callbacks. Returns an unregister function. */
  addListener: (callbacks: DesktopWsCallbacks) => () => void;
  /** Subscribe to a session key for chat/history. Returns an unsubscribe function. */
  addSessionSubscription: (sessionKey: string) => () => void;
}

// ── WS lifecycle → window event bridge ──
//
// The ws-server broadcasts `agent-lifecycle` / `lane-lifecycle` on every agent
// state change, and six surfaces listen for the matching WINDOW event. Nothing
// ever connected the two: that window event was dispatched only by two local
// kill-buttons, so every one of those surfaces was poll-only for any change that
// did not originate from a click in this window. That missing wire is the reason
// they poll at all.
//
// Every lifecycle payload stays observable on its original channel. Bulk
// refetch listeners use the separate signal below, so a fleet burst reconciles
// once without hiding intermediate terminal or retirement transitions.
const LIFECYCLE_COALESCE_MS = 250;
let lifecycleLastReconcile = 0;
let lifecycleTrailing: ReturnType<typeof setTimeout> | null = null;

function emitWindowLifecycle(
  name: 'o8:agent-lifecycle' | 'o8:lane-lifecycle',
  detail: { channel: string; event: string; data: Record<string, unknown> | undefined },
) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
  const now = Date.now();
  const sinceLast = now - lifecycleLastReconcile;

  if (sinceLast >= LIFECYCLE_COALESCE_MS) {
    lifecycleLastReconcile = now;
    window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
    return;
  }
  if (lifecycleTrailing) return;
  lifecycleTrailing = setTimeout(() => {
    lifecycleTrailing = null;
    lifecycleLastReconcile = Date.now();
    window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
  }, LIFECYCLE_COALESCE_MS - sinceLast);
}

const SharedWsContext = createContext<SharedWsContextValue | null>(null);

/** Lightweight hook for components that only need WS connection state (e.g. approval polling). */
export function useWsConnectionState(): WsConnectionState {
  const ctx = useContext(SharedWsContext);
  return ctx?.connectionState ?? 'disconnected';
}

// ── Provider ──

export function DesktopWebSocketProvider({ children }: { children: ReactNode }) {
  const [connectionState, setConnectionState] = useState<WsConnectionState>('disconnected');
  const connectionStateRef = useRef<WsConnectionState>(connectionState);
  connectionStateRef.current = connectionState;
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(INITIAL_BACKOFF);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const disposedRef = useRef(false);
  const realtimeSeqByStreamRef = useRef<Record<string, number>>({});

  // Callback registry — multiple components register their handlers
  const nextIdRef = useRef<ListenerId>(0);
  const listenersRef = useRef<Map<ListenerId, DesktopWsCallbacks>>(new Map());

  // Session subscriptions — multiple components can subscribe to session keys.
  // When the set of active session keys changes, we send a switch-session for
  // the most recently subscribed key.
  const sessionSubsRef = useRef<Map<ListenerId, string>>(new Map());
  const activeSessionKeyRef = useRef<string | undefined>(undefined);

  const addListener = useCallback((callbacks: DesktopWsCallbacks) => {
    const id = nextIdRef.current++;
    listenersRef.current.set(id, callbacks);
    return () => { listenersRef.current.delete(id); };
  }, []);

  const addSessionSubscription = useCallback((sessionKey: string) => {
    const id = nextIdRef.current++;
    sessionSubsRef.current.set(id, sessionKey);
    // Switch to the new session
    activeSessionKeyRef.current = sessionKey;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'switch-session', sessionKey }));
      const subscriptions: RealtimeSubscription[] = [
        { stream: 'global', since: realtimeSeqByStreamRef.current.global },
        { stream: `session:${sessionKey}`, since: realtimeSeqByStreamRef.current[`session:${sessionKey}`] },
      ];
      wsRef.current.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions }));
    }
    return () => {
      sessionSubsRef.current.delete(id);
      // If this was the active session, switch to the most recent remaining one
      const remaining = [...sessionSubsRef.current.values()];
      const nextKey = remaining[remaining.length - 1];
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        if (nextKey && nextKey !== activeSessionKeyRef.current) {
          activeSessionKeyRef.current = nextKey;
          wsRef.current.send(JSON.stringify({ type: 'switch-session', sessionKey: nextKey }));
          const subscriptions: RealtimeSubscription[] = [
            { stream: 'global', since: realtimeSeqByStreamRef.current.global },
            { stream: `session:${nextKey}`, since: realtimeSeqByStreamRef.current[`session:${nextKey}`] },
          ];
          wsRef.current.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions }));
        } else if (!nextKey) {
          activeSessionKeyRef.current = undefined;
          wsRef.current.send(JSON.stringify({
            type: 'realtime-subscribe',
            subscriptions: [{ stream: 'global', since: realtimeSeqByStreamRef.current.global }],
          }));
        }
      }
    };
  }, []);

  // ── Imperative commands ──

  const wsSend = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const switchSession = useCallback((key: string) => {
    activeSessionKeyRef.current = key;
    wsSend({ type: 'switch-session', sessionKey: key });
  }, [wsSend]);

  const sendTerminalCreate = useCallback((cols: number, rows: number, requestId?: string) => {
    wsSend({ type: 'terminal-create', cols, rows, requestId });
  }, [wsSend]);

  const sendTerminalAttach = useCallback((sessionName: string, cols: number, rows: number) => {
    wsSend({ type: 'terminal-attach', sessionName, cols, rows });
  }, [wsSend]);

  const sendTerminalInput = useCallback((sessionName: string, data: string) => {
    wsSend({ type: 'terminal-input', sessionName, data });
  }, [wsSend]);

  const sendTerminalResize = useCallback((sessionName: string, cols: number, rows: number) => {
    wsSend({ type: 'terminal-resize', sessionName, cols, rows });
  }, [wsSend]);

  const sendTerminalDetach = useCallback((sessionName: string) => {
    wsSend({ type: 'terminal-detach', sessionName });
  }, [wsSend]);

  const sendAgentKill = useCallback((sessionName: string, signal: 'SIGTERM' | 'SIGINT' = 'SIGTERM') => {
    wsSend({ type: 'agent-kill', sessionName, signal });
  }, [wsSend]);

  // ── Connection effect (runs once) ──

  useEffect(() => {
    disposedRef.current = false;
    const url = getWsUrl();
    if (!url) return;

    function dispatch(method: keyof DesktopWsCallbacks, ...args: unknown[]) {
      for (const cb of listenersRef.current.values()) {
        const fn = cb[method] as ((...a: unknown[]) => void) | undefined;
        if (fn) {
          try { fn(...args); } catch { /* listener error */ }
        }
      }
    }

    function handleMessage(event: MessageEvent) {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : ''); } catch { return; }

      const channel = msg.channel as string;
      const eventType = msg.event as string;
      const data = msg.data as Record<string, unknown> | undefined;

      // Bridge WS events to window CustomEvents for TanStack Query invalidation.
      // Any useReactiveQuery({ wsEvents: ['lane-lifecycle'] }) will hear this.
      if (channel && channel !== 'system' && channel !== 'pong' && channel !== 'agent-lifecycle' && channel !== 'lane-lifecycle') {
        window.dispatchEvent(new CustomEvent(`o8:${channel}`, {
          detail: { channel, event: eventType, data },
        }));
      }

      switch (channel) {
        case 'system':
          if (eventType === 'connected') {
            setConnectionState('connected');
            backoffRef.current = INITIAL_BACKOFF;
          }
          break;
        case 'realtime':
          if (eventType === 'batch' && Array.isArray(data?.events)) {
            const events = data.events as RealtimeEventEnvelope[];
            for (const realtimeEvent of events) {
              realtimeSeqByStreamRef.current[realtimeEvent.stream] = Math.max(
                realtimeSeqByStreamRef.current[realtimeEvent.stream] ?? 0,
                realtimeEvent.seq,
              );
              dispatch('onRealtimeEvent', realtimeEvent);
            }
          }
          break;
        case 'inbox':
          if (eventType === 'update' && data) dispatch('onInboxUpdate', data);
          break;
        case 'history':
          if (eventType === 'update' && data) {
            const sk = data.sessionKey as string;
            const entries = data.entries as Array<Record<string, unknown>>;
            if (sk && entries?.length > 0) dispatch('onHistoryUpdate', sk, entries, Boolean(data.replace));
          }
          break;
        case 'chat':
          if (eventType === 'delta' && data?.text) {
            dispatch('onChatDelta', data.text as string, (data.runId as string) ?? '');
          } else if (eventType === 'done') {
            dispatch('onChatDone', (data?.text as string) ?? '', (data?.runId as string) ?? '');
          } else if (eventType === 'error') {
            dispatch('onChatError', (data?.error as string) ?? 'Unknown error');
          }
          break;
        case 'review':
          if (data) dispatch('onReviewUpdate', { event: eventType, ...data });
          break;
        case 'terminal':
          if (eventType === 'created' && data) dispatch('onTerminalCreated', data.sessionName as string, data.requestId as string | undefined);
          else if (eventType === 'data' && data) dispatch('onTerminalData', data.sessionName as string, data.data as string);
          else if (eventType === 'attached' && data) dispatch('onTerminalAttached', data.sessionName as string);
          else if (eventType === 'exited' && data) dispatch('onTerminalExited', data.sessionName as string, (data.exitCode as number) ?? 0);
          else if (eventType === 'error' && data) dispatch('onTerminalError', data.sessionName as string, (data.error as string) ?? 'Unknown error');
          else if (eventType === 'image' && data) dispatch('onTerminalImage', data.sessionName as string, data.imageB64 as string, (data.filename as string) ?? 'image.png');
          break;
        case 'agent-lifecycle':
          if (data) dispatch('onAgentLifecycle', data.sessionName as string, data.state as string, data.exitCode as number | undefined);
          // The ws-server has always broadcast this. Six surfaces have always
          // listened for the matching WINDOW event (useAgentPanelState x3,
          // AgentPanelExtraAgents, footer-ports, OrchestratorRunStrip) — but
          // nothing ever bridged the two, so that window event was only fired by
          // two local kill-buttons. Every one of those surfaces was therefore
          // poll-only for any lifecycle change that did not originate from a
          // click in this window, which is exactly why they poll at all.
          emitWindowLifecycle('o8:agent-lifecycle', { channel, event: eventType, data });
          break;
        case 'lane-lifecycle':
          if (data) dispatch('onLaneLifecycle', data);
          emitWindowLifecycle('o8:lane-lifecycle', { channel, event: eventType, data });
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
        const isReconnect = wsRef.current === null && connectionStateRef.current === 'reconnecting';
        wsRef.current = ws;
        // Re-subscribe to current session
        const key = activeSessionKeyRef.current;
        if (key) {
          ws.send(JSON.stringify({ type: 'subscribe', sessionKey: key }));
        }
        // On reconnect, reset seq counters to force fresh bootstrap snapshot
        // so the client gets current agent statuses instead of stale cache
        const globalSince = isReconnect ? 0 : (realtimeSeqByStreamRef.current.global ?? 0);
        const subscriptions: RealtimeSubscription[] = [{ stream: 'global', since: globalSince }];
        if (key) {
          const sessionSince = isReconnect ? 0 : (realtimeSeqByStreamRef.current[`session:${key}`] ?? 0);
          subscriptions.push({ stream: `session:${key}`, since: sessionSince });
        }
        ws.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions }));
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

  const value = useMemo<SharedWsContextValue>(() => ({
    connectionState,
    isConnected: connectionState === 'connected',
    addListener,
    addSessionSubscription,
    switchSession,
    sendTerminalCreate,
    sendTerminalAttach,
    sendTerminalInput,
    sendTerminalResize,
    sendTerminalDetach,
    sendAgentKill,
  }), [
    connectionState, addListener, addSessionSubscription,
    switchSession, sendTerminalCreate, sendTerminalAttach,
    sendTerminalInput, sendTerminalResize, sendTerminalDetach,
    sendAgentKill,
  ]);

  return (
    <SharedWsContext.Provider value={value}>
      {children}
    </SharedWsContext.Provider>
  );
}

// ── Consumer hook — drop-in replacement for useDesktopWebSocket ──

interface UseSharedDesktopWsResult {
  connectionState: WsConnectionState;
  isConnected: boolean;
  switchSession: (sessionKey: string) => void;
  sendTerminalCreate: (cols: number, rows: number, requestId?: string) => void;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
  sendAgentKill: (sessionName: string, signal?: 'SIGTERM' | 'SIGINT') => void;
}

/**
 * Subscribe to the shared desktop WebSocket connection.
 * Same API as the old useDesktopWebSocket — callbacks are registered
 * with the shared provider and called when matching messages arrive.
 *
 * If sessionKey is provided, the connection is subscribed to that session
 * for chat/history events.
 */
export function useSharedDesktopWs(
  sessionKey: string | undefined,
  callbacks: DesktopWsCallbacks,
): UseSharedDesktopWsResult {
  const ctx = useContext(SharedWsContext);
  if (!ctx) throw new Error('useSharedDesktopWs must be used within DesktopWebSocketProvider');

  // Register callbacks (synced via effect to avoid render-time ref mutation)
  const cbRef = useRef(callbacks);
  useEffect(() => { cbRef.current = callbacks; });

  // Stable wrapper so the listener registration doesn't change on every render
  const stableCallbacks = useMemo<DesktopWsCallbacks>(() => ({
    onChatDelta: (...args: Parameters<NonNullable<DesktopWsCallbacks['onChatDelta']>>) => cbRef.current.onChatDelta?.(...args),
    onChatDone: (...args: Parameters<NonNullable<DesktopWsCallbacks['onChatDone']>>) => cbRef.current.onChatDone?.(...args),
    onChatError: (...args: Parameters<NonNullable<DesktopWsCallbacks['onChatError']>>) => cbRef.current.onChatError?.(...args),
    onRealtimeEvent: (...args: Parameters<NonNullable<DesktopWsCallbacks['onRealtimeEvent']>>) => cbRef.current.onRealtimeEvent?.(...args),
    onInboxUpdate: (...args: Parameters<NonNullable<DesktopWsCallbacks['onInboxUpdate']>>) => cbRef.current.onInboxUpdate?.(...args),
    onHistoryUpdate: (...args: Parameters<NonNullable<DesktopWsCallbacks['onHistoryUpdate']>>) => cbRef.current.onHistoryUpdate?.(...args),
    onReviewUpdate: (...args: Parameters<NonNullable<DesktopWsCallbacks['onReviewUpdate']>>) => cbRef.current.onReviewUpdate?.(...args),
    onTerminalCreated: (...args: Parameters<NonNullable<DesktopWsCallbacks['onTerminalCreated']>>) => cbRef.current.onTerminalCreated?.(...args),
    onTerminalData: (...args: Parameters<NonNullable<DesktopWsCallbacks['onTerminalData']>>) => cbRef.current.onTerminalData?.(...args),
    onTerminalAttached: (...args: Parameters<NonNullable<DesktopWsCallbacks['onTerminalAttached']>>) => cbRef.current.onTerminalAttached?.(...args),
    onTerminalExited: (...args: Parameters<NonNullable<DesktopWsCallbacks['onTerminalExited']>>) => cbRef.current.onTerminalExited?.(...args),
    onTerminalError: (...args: Parameters<NonNullable<DesktopWsCallbacks['onTerminalError']>>) => cbRef.current.onTerminalError?.(...args),
    onTerminalImage: (...args: Parameters<NonNullable<DesktopWsCallbacks['onTerminalImage']>>) => cbRef.current.onTerminalImage?.(...args),
    onAgentLifecycle: (...args: Parameters<NonNullable<DesktopWsCallbacks['onAgentLifecycle']>>) => cbRef.current.onAgentLifecycle?.(...args),
    onLaneLifecycle: (...args: Parameters<NonNullable<DesktopWsCallbacks['onLaneLifecycle']>>) => cbRef.current.onLaneLifecycle?.(...args),
  }), []);

  useEffect(() => ctx.addListener(stableCallbacks), [ctx, stableCallbacks]);

  // Subscribe to session for chat/history
  useEffect(() => {
    if (!sessionKey) return;
    return ctx.addSessionSubscription(sessionKey);
  }, [ctx, sessionKey]);

  return {
    connectionState: ctx.connectionState,
    isConnected: ctx.isConnected,
    switchSession: ctx.switchSession,
    sendTerminalCreate: ctx.sendTerminalCreate,
    sendTerminalAttach: ctx.sendTerminalAttach,
    sendTerminalInput: ctx.sendTerminalInput,
    sendTerminalResize: ctx.sendTerminalResize,
    sendTerminalDetach: ctx.sendTerminalDetach,
    sendAgentKill: ctx.sendAgentKill,
  };
}
