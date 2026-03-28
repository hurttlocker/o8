'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

export type OrchestratorStreamStatus = 'connecting' | 'ready' | 'busy' | 'error' | 'dead';

interface OrchestratorStreamResult {
  messages: MobileTranscriptEntry[];
  status: OrchestratorStreamStatus;
  send: (message: string) => void;
  reset: () => void;
  connected: boolean;
}

const WS_TOKEN = 'cortex-ide';
const WS_URL = typeof window !== 'undefined'
  ? `ws://${window.location.hostname}:3002/ws?token=${WS_TOKEN}`
  : `ws://localhost:3002/ws?token=${WS_TOKEN}`;

/**
 * Hook that connects to the orchestrator WebSocket channel for real-time
 * Claude Code streaming. Replaces the poll-based orchestrator flow.
 *
 * Connects to ws-server on port 3002, subscribes to the orchestrator channel,
 * and accumulates output into renderable MobileTranscriptEntry messages.
 */
export function useOrchestratorStream(repoPath: string | null): OrchestratorStreamResult {
  const [messages, setMessages] = useState<MobileTranscriptEntry[]>([]);
  const [status, setStatus] = useState<OrchestratorStreamStatus>('connecting');
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const currentAssistantRef = useRef<{ id: string; chunks: string[]; thinkingChunks: string[] } | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const repoPathRef = useRef(repoPath);
  repoPathRef.current = repoPath;

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

    const ws = new WebSocket(WS_URL);
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
    };

    ws.onmessage = (event) => {
      let msg: { channel?: string; event?: string; data?: Record<string, unknown> };
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }

      if (msg.channel !== 'orchestrator') return;

      switch (msg.event) {
        case 'output': {
          const text = typeof msg.data?.text === 'string' ? msg.data.text : '';
          if (!text) break;
          const isThinking = msg.data?.thinking === true;

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
            if (newStatus === 'ready' && currentAssistantRef.current) {
              flushCurrentAssistant();
              currentAssistantRef.current = null;
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

          setMessages(prev => [...prev, {
            id: `agent-update-${update.surfaceId}-${Date.now()}`,
            role: 'system',
            text: update.detail ?? `Agent "${update.name ?? update.surfaceId}" is now ${update.status ?? 'unknown'}`,
            timestamp: Date.now(),
            timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          }]);

          // Dispatch to dashboard so it can auto-open workspace tabs
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('cortex:agent-supervisor-update', { detail: update }));
          }
          break;
        }

        case 'error': {
          const error = typeof msg.data?.error === 'string' ? msg.data.error : 'Unknown error';
          console.error('[orchestrator-stream] Error:', error);
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

      // Auto-reconnect after 2s
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        if (repoPathRef.current) connect();
      }, 2000);
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }, [flushCurrentAssistant]); // eslint-disable-line react-hooks/exhaustive-deps — status read via closure is intentional, not a dep

  // Connect on mount / repoPath change
  useEffect(() => {
    if (!repoPath) return;

    connect();

    return () => {
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

  const send = useCallback((message: string) => {
    if (!repoPathRef.current) return;

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
    setStatus('busy');

    // Send via WebSocket
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'orchestrator-send',
        repoPath: repoPathRef.current,
        message,
      }));
    } else {
      // Fallback: try to reconnect and send
      console.warn('[orchestrator-stream] WS not open, attempting reconnect...');
      connect();
      // Queue the send for after reconnect
      const waitAndSend = setInterval(() => {
        const currentWs = wsRef.current;
        if (currentWs?.readyState === WebSocket.OPEN) {
          clearInterval(waitAndSend);
          currentWs.send(JSON.stringify({
            type: 'orchestrator-send',
            repoPath: repoPathRef.current,
            message,
          }));
        }
      }, 200);
      // Give up after 5s
      setTimeout(() => clearInterval(waitAndSend), 5000);
    }
  }, [connect]);

  const reset = useCallback(() => {
    setMessages([]);
    currentAssistantRef.current = null;
    setStatus(connected ? 'ready' : 'connecting');
  }, [connected]);

  return { messages, status, send, reset, connected };
}
