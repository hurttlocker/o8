'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { getBrowserWsPort } from '@/lib/panel/ws-port-client';

export type OrchestratorStreamStatus = 'connecting' | 'ready' | 'busy' | 'error' | 'dead';

export type OrchestratorPermissionMode = 'full' | 'plan';

interface OrchestratorStreamResult {
  messages: MobileTranscriptEntry[];
  planText: string | null;
  status: OrchestratorStreamStatus;
  send: (message: string, options?: { permissionMode?: OrchestratorPermissionMode; thinkingEffort?: 'medium' | 'high' | 'max' }) => void;
  reset: () => void;
  connected: boolean;
}

let agentUpdateSeq = 0;

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

/**
 * Hook that connects to the orchestrator WebSocket channel for real-time
 * Claude Code streaming. Replaces the poll-based orchestrator flow.
 *
 * Connects to ws-server on port 3002, subscribes to the orchestrator channel,
 * and accumulates output into renderable MobileTranscriptEntry messages.
 */
export function useOrchestratorStream(
  repoPath: string | null,
  options?: { seededPlanText?: string | null; hasHistory?: boolean },
): OrchestratorStreamResult {
  const [messages, setMessages] = useState<MobileTranscriptEntry[]>([]);
  const [planText, setPlanText] = useState<string | null>(null);
  const [status, setStatus] = useState<OrchestratorStreamStatus>('connecting');
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const currentAssistantRef = useRef<{ id: string; chunks: string[]; thinkingChunks: string[] } | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const repoPathRef = useRef(repoPath);
  repoPathRef.current = repoPath;
  const mountedRef = useRef(false);
  const messagesRef = useRef<MobileTranscriptEntry[]>([]);
  const planTextRef = useRef<string | null>(null);
  const hasHistory = options?.hasHistory ?? false;
  const seededPlanText = options?.seededPlanText ?? null;

  const hasHistoryRef = useRef(Boolean(hasHistory));
  const captureFirstTurnPlanRef = useRef(false);
  const firstTurnPlanStartedRef = useRef(false);
  const firstTurnPlanChunksRef = useRef<string[]>([]);

  // #539 — reconnect reconciliation. eventCountRef advances on every relevant
  // orchestrator event; lastEventAtRef tracks wall-clock time of the last
  // event. Together they let us detect stale "busy" state after a ws-server
  // restart (no events arrive post-reconnect) or a dead backend turn (no
  // events for > HEAL_STALE_AFTER_MS while the UI still thinks it's working).
  const eventCountRef = useRef(0);
  const lastEventAtRef = useRef<number>(Date.now());
  const RECONNECT_HEAL_DELAY_MS = 3000;
  const HEAL_STALE_AFTER_MS = 300_000;
  const HEAL_POLL_INTERVAL_MS = 30_000;

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    hasHistoryRef.current = Boolean(hasHistory);
  }, [hasHistory]);

  useEffect(() => {
    const trimmed = seededPlanText?.trim();
    if (!trimmed || planTextRef.current === trimmed) {
      return;
    }

    planTextRef.current = trimmed;
    setPlanText(trimmed);
  }, [seededPlanText]);

  const resetFirstTurnPlanCapture = useCallback(() => {
    captureFirstTurnPlanRef.current = false;
    firstTurnPlanStartedRef.current = false;
    firstTurnPlanChunksRef.current = [];
  }, []);

  const finalizeFirstTurnPlanCapture = useCallback(() => {
    if (!captureFirstTurnPlanRef.current || planTextRef.current) {
      resetFirstTurnPlanCapture();
      return;
    }

    const nextPlanText = firstTurnPlanChunksRef.current.join('').trim();
    resetFirstTurnPlanCapture();

    if (!nextPlanText) {
      return;
    }

    planTextRef.current = nextPlanText;
    setPlanText(nextPlanText);
  }, [resetFirstTurnPlanCapture]);

  // #539 — clear any stale "running" state when the client's local view of
  // a busy turn no longer matches reality. Used by both the reconnect heal
  // and the heartbeat-based stall detector. Idempotent — safe to call when
  // nothing needs healing.
  const healStaleBusyState = useCallback((reason: string) => {
    const hasStaleStatus = statusRef.current === 'busy';
    const hasOrphanAssistant = currentAssistantRef.current !== null;
    const hasRunningTools = messagesRef.current.some((m) =>
      m.toolCalls?.some((t) => t.status === 'running'),
    );
    if (!hasStaleStatus && !hasOrphanAssistant && !hasRunningTools) return;

    console.warn(`[orchestrator-stream] Healing stale busy state: ${reason}`);
    if (hasStaleStatus) setStatus('ready');
    if (hasOrphanAssistant) currentAssistantRef.current = null;
    if (hasRunningTools) {
      setMessages((prev) =>
        prev.map((m) =>
          m.toolCalls?.some((t) => t.status === 'running')
            ? { ...m, toolCalls: m.toolCalls.map((t) => (t.status === 'running' ? { ...t, status: 'done' as const } : t)) }
            : m,
        ),
      );
    }
  }, []);

  const flushCurrentAssistant = useCallback(() => {
    const current = currentAssistantRef.current;
    if (!current || (current.chunks.length === 0 && current.thinkingChunks.length === 0)) return;

    const text = current.chunks.join('\n');
    const thinking = current.thinkingChunks.length > 0 ? current.thinkingChunks.join('\n') : undefined;
    const entry: MobileTranscriptEntry = {
      id: current.id,
      role: 'assistant',
      text: text || (thinking ? '' : ''),
      thinking,
      timestamp: Date.now(),
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === current.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = entry;
        return next;
      }
      return [...prev, entry];
    });
  }, []);

  const connect = useCallback(() => {
    if (!repoPathRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;
    const wsUrl = getWsUrl();
    if (!wsUrl) return;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setStatus('connecting');

      // Subscribe to orchestrator channel
      ws.send(JSON.stringify({
        type: 'orchestrator-subscribe',
        repoPath: repoPathRef.current,
      }));

      console.log('[orchestrator-stream] Connected, subscribing...');

      // #539 — reconnect heal. If this is a fresh connect, status is already
      // 'connecting' and the heal is a no-op. If we're reconnecting after a
      // ws-server restart or a network flap, any "busy" state we carried over
      // is potentially stale. Give the server 3 seconds to push events for a
      // genuinely active turn; if nothing arrives, clear the stale indicators.
      const countAtOpen = eventCountRef.current;
      setTimeout(() => {
        if (ws !== wsRef.current) return;
        if (eventCountRef.current !== countAtOpen) return;
        if (statusRef.current === 'busy' || currentAssistantRef.current) {
          healStaleBusyState('reconnect with no follow-up events after 3s');
        }
      }, RECONNECT_HEAL_DELAY_MS);
    };

    ws.onmessage = (event) => {
      // Ignore messages from a stale/closed connection (StrictMode double-mount race)
      if (ws !== wsRef.current) return;

      let msg: { channel?: string; event?: string; data?: Record<string, unknown> };
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }

      if (msg.channel !== 'orchestrator') return;

      // #539 — signal liveness for the reconnect heal + stall watchdog.
      eventCountRef.current += 1;
      lastEventAtRef.current = Date.now();

      switch (msg.event) {
        case 'output': {
          const text = typeof msg.data?.text === 'string' ? msg.data.text : '';
          if (!text) break;
          const isThinking = msg.data?.thinking === true;

          if (!isThinking && captureFirstTurnPlanRef.current) {
            if (firstTurnPlanStartedRef.current || text.trim()) {
              firstTurnPlanStartedRef.current = true;
              firstTurnPlanChunksRef.current.push(text);
            }
          }

          // Start a new assistant message if we don't have one
          if (!currentAssistantRef.current) {
            currentAssistantRef.current = {
              id: `orch-assistant-${Date.now()}`,
              chunks: [],
              thinkingChunks: [],
            };
          }

          if (isThinking) {
            currentAssistantRef.current.thinkingChunks.push(text);
          } else {
            currentAssistantRef.current.chunks.push(text);
          }
          flushCurrentAssistant();

          if (statusRef.current !== 'busy') setStatus('busy');
          break;
        }

        case 'status': {
          const newStatus = msg.data?.status as string | undefined;
          if (newStatus === 'ready' || newStatus === 'busy' || newStatus === 'dead') {
            setStatus(newStatus);

            // When agent goes ready, finalize current assistant message
            // and mark any running tools as done
            if (newStatus === 'ready' && currentAssistantRef.current) {
              finalizeFirstTurnPlanCapture();
              flushCurrentAssistant();
              const finalId = currentAssistantRef.current.id;
              setMessages(prev => prev.map(m =>
                m.id === finalId && m.toolCalls?.some(t => t.status === 'running')
                  ? { ...m, toolCalls: m.toolCalls!.map(t => t.status === 'running' ? { ...t, status: 'done' } : t) }
                  : m
              ));
              currentAssistantRef.current = null;
            }
            if (newStatus === 'dead') {
              finalizeFirstTurnPlanCapture();
            }
          } else if (newStatus === 'starting') {
            setStatus('connecting');
          }
          break;
        }

        case 'agent-update': {
          const update = msg.data as {
            surfaceId?: string;
            name?: string;
            status?: string;
            detail?: string;
            duration?: number;
            repoPath?: string;
            prompt?: string;
          } | undefined;
          if (!update?.surfaceId) break;

          const detailText = update.detail ?? `Agent "${update.name ?? update.surfaceId}" is now ${update.status ?? 'unknown'}`;
          setMessages(prev => {
            // Dedup: skip if we already have an update for this surfaceId with the same detail
            const isDupe = prev.some(m =>
              m.id.startsWith(`agent-update-${update.surfaceId}`) &&
              m.text === detailText
            );
            if (isDupe) return prev;
            return [...prev, {
              id: `agent-update-${update.surfaceId}-${++agentUpdateSeq}`,
              role: 'system',
              text: detailText,
              timestamp: Date.now(),
              timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            }];
          });

          // Dispatch to dashboard so it can auto-open workspace tabs
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('cortex:agent-supervisor-update', { detail: update }));
          }
          break;
        }

        case 'tool-use': {
          const toolName = typeof msg.data?.name === 'string' ? msg.data.name : 'unknown';
          finalizeFirstTurnPlanCapture();

          // Ensure we have a current assistant message to attach the tool call to
          if (!currentAssistantRef.current) {
            currentAssistantRef.current = {
              id: `orch-assistant-${Date.now()}`,
              chunks: [],
              thinkingChunks: [],
            };
          }

          // Append to messages with toolCalls
          const current = currentAssistantRef.current;
          const toolCall = { name: toolName, status: 'running' as const };
          setMessages(prev => {
            const idx = prev.findIndex(m => m.id === current.id);
            if (idx >= 0) {
              const next = [...prev];
              const existing = next[idx];
              const existingTools = existing.toolCalls ?? [];
              // Mark previous running tools as done
              const updatedTools = existingTools.map(t =>
                t.status === 'running' ? { ...t, status: 'done' as const } : t,
              );
              next[idx] = { ...existing, toolCalls: [...updatedTools, toolCall] };
              return next;
            }
            // New message with tool call
            return [...prev, {
              id: current.id,
              role: 'assistant' as const,
              text: '',
              toolCalls: [toolCall],
              timestamp: Date.now(),
              timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            }];
          });

          if (statusRef.current !== 'busy') setStatus('busy');
          break;
        }

        case 'error': {
          const error = typeof msg.data?.error === 'string' ? msg.data.error : 'Unknown error';
          console.error('[orchestrator-stream] Error:', error);
          finalizeFirstTurnPlanCapture();
          setStatus('error');
          setMessages(prev => [...prev, {
            id: `orch-error-${Date.now()}`,
            role: 'system',
            text: `Orchestrator error: ${error}`,
            timestamp: Date.now(),
            timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          }]);
          break;
        }
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      console.log('[orchestrator-stream] Disconnected');

      // Auto-reconnect after 2s — but only if still mounted
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (!mountedRef.current) return;
      reconnectTimerRef.current = setTimeout(() => {
        if (repoPathRef.current && mountedRef.current) connect();
      }, 2000);
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }, [flushCurrentAssistant]);

  // Connect on mount / repoPath change
  useEffect(() => {
    if (!repoPath) return;

    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        // Unsubscribe before closing
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'orchestrator-unsubscribe' }));
        }
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [repoPath, connect]);

  // #539 — stall watchdog. If the UI stays in 'busy' state for > 5 minutes
  // without any events from the stream, the backend turn is almost certainly
  // dead even if the WS is still connected. Heal so the composer unlocks.
  useEffect(() => {
    if (!repoPath) return;

    const interval = setInterval(() => {
      if (statusRef.current !== 'busy') return;
      const quietFor = Date.now() - lastEventAtRef.current;
      if (quietFor >= HEAL_STALE_AFTER_MS) {
        healStaleBusyState(`no events for ${Math.round(quietFor / 1000)}s while status=busy`);
      }
    }, HEAL_POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [repoPath, healStaleBusyState]);

  const send = useCallback((message: string, options?: { permissionMode?: OrchestratorPermissionMode; thinkingEffort?: 'medium' | 'high' | 'max' }) => {
    if (!repoPathRef.current) return;

    const permissionMode: OrchestratorPermissionMode = options?.permissionMode ?? 'full';
    const thinkingEffort = options?.thinkingEffort ?? 'max';

    // Add user message to local state immediately
    const userEntry: MobileTranscriptEntry = {
      id: `orch-user-${Date.now()}`,
      role: 'user',
      text: message,
      timestamp: Date.now(),
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setMessages(prev => [...prev, userEntry]);

    // Reset current assistant accumulator for the new response
    currentAssistantRef.current = null;
    captureFirstTurnPlanRef.current = !planTextRef.current
      && !hasHistoryRef.current
      && !messagesRef.current.some((entry) => entry.role === 'assistant' || entry.role === 'system' || entry.role === 'tool');
    firstTurnPlanStartedRef.current = false;
    firstTurnPlanChunksRef.current = [];
    setStatus('busy');

    const payload = JSON.stringify({
      type: 'orchestrator-send',
      repoPath: repoPathRef.current,
      message,
      permissionMode,
      thinkingEffort,
    });

    // Send via WebSocket
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(payload);
    } else {
      // Fallback: try to reconnect and send
      console.warn('[orchestrator-stream] WS not open, attempting reconnect...');
      connect();
      // Queue the send for after reconnect
      const waitAndSend = setInterval(() => {
        const currentWs = wsRef.current;
        if (currentWs?.readyState === WebSocket.OPEN) {
          clearInterval(waitAndSend);
          currentWs.send(payload);
        }
      }, 200);
      // Give up after 5s
      setTimeout(() => clearInterval(waitAndSend), 5000);
    }
  }, [connect]);

  const reset = useCallback(() => {
    setMessages([]);
    setPlanText(null);
    currentAssistantRef.current = null;
    planTextRef.current = null;
    resetFirstTurnPlanCapture();
    setStatus(connected ? 'ready' : 'connecting');
  }, [connected, resetFirstTurnPlanCapture]);

  return { messages, planText, status, send, reset, connected };
}
