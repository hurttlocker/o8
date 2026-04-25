'use client';

/**
 * useOrchestratorMobile — dedicated WS + history hook for the mobile
 * Orchestrator tab.
 *
 * Why a second WS connection: the main mobile useWebSocket hook subscribes
 * to the `orchestrator` channel on the *currently selected session's*
 * repoPath, which is fine for the inline orchestrator status pill on the
 * chat surface. The Orchestrator tab needs to subscribe to whatever repo
 * the user picked from the thread list — independently of session focus.
 * Opening a parallel client is the cleanest way to do that without
 * threading state through the existing hook.
 *
 * Channels handled (mirrors src/ws-server.ts):
 *   orchestrator/output       text + thinking deltas
 *   orchestrator/tool-use     name + args
 *   orchestrator/tool-result  output preview
 *   orchestrator/status       ready | busy | dead
 *   orchestrator/error        error string
 *
 * Output deltas accumulate into the LAST assistant entry until a `done`
 * status arrives, at which point the buffer is committed and the next
 * delta starts a new entry.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBrowserWsPort } from '@/lib/panel/ws-port-client';
import type {
  MobileOrchestratorThread,
  MobileOrchestratorTranscriptEntry,
} from '@/lib/mobile/types';

export type MobileOrchestratorConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

export type MobileOrchestratorTurnStatus = 'idle' | 'busy' | 'error';

interface UseOrchestratorMobileArgs {
  /** Active thread (already loaded from threads list). null = no thread picked. */
  activeThread: MobileOrchestratorThread | null;
}

interface UseOrchestratorMobileResult {
  connectionState: MobileOrchestratorConnectionState;
  turnStatus: MobileOrchestratorTurnStatus;
  transcript: MobileOrchestratorTranscriptEntry[];
  transcriptLoading: boolean;
  errorNote: string | null;
  sendMessage: (text: string) => void;
  interrupt: () => void;
  resetTranscript: () => void;
}

const INITIAL_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;
const PING_INTERVAL = 20_000;
const STREAM_FLUSH_MS = 60;

interface ChatHistoryMessage {
  role?: string;
  content?: string;
}

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

function transcriptIdFor(prefix: 'user' | 'assistant' | 'tool' | 'system') {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function historyToTranscript(messages: ChatHistoryMessage[]): MobileOrchestratorTranscriptEntry[] {
  const entries: MobileOrchestratorTranscriptEntry[] = [];
  let counter = 0;
  for (const message of messages) {
    if (typeof message.content !== 'string') continue;
    const text = message.content.trim();
    if (!text) continue;
    const role: MobileOrchestratorTranscriptEntry['role'] =
      message.role === 'user' ? 'user'
        : message.role === 'assistant' ? 'assistant'
          : message.role === 'tool' ? 'tool'
            : 'system';
    entries.push({
      id: `history-${counter++}`,
      role,
      text,
      timestamp: Date.now() - (messages.length - counter),
    });
  }
  return entries;
}

export function useOrchestratorMobile({
  activeThread,
}: UseOrchestratorMobileArgs): UseOrchestratorMobileResult {
  const [connectionState, setConnectionState] = useState<MobileOrchestratorConnectionState>('disconnected');
  const [turnStatus, setTurnStatus] = useState<MobileOrchestratorTurnStatus>('idle');
  const [transcript, setTranscript] = useState<MobileOrchestratorTranscriptEntry[]>([]);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [errorNote, setErrorNote] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const disposedRef = useRef(false);
  const backoffRef = useRef(INITIAL_BACKOFF);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The repoPath we're currently subscribed to on the WS — kept in a ref so
  // reconnects re-subscribe to the latest repo without re-running the
  // connection effect.
  const subscribedRepoRef = useRef<string | null>(null);
  const repoPathRef = useRef<string | null>(activeThread?.repoPath ?? null);

  // Streaming buffer for the current assistant turn. Output deltas append to
  // .text and we flush to the React transcript on a 60ms interval to keep
  // re-renders cheap on phone.
  const streamingBufferRef = useRef<{
    id: string;
    text: string;
    thinking: boolean;
    flushed: boolean;
  } | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    repoPathRef.current = activeThread?.repoPath ?? null;
  }, [activeThread?.repoPath]);

  const flushStreamingBuffer = useCallback(() => {
    const buffer = streamingBufferRef.current;
    if (!buffer || buffer.flushed) return;
    buffer.flushed = true;

    setTranscript((current) => {
      const last = current[current.length - 1];
      if (last && last.id === buffer.id) {
        if (last.text === buffer.text && last.thinking === buffer.thinking) return current;
        const next = current.slice(0, -1);
        next.push({ ...last, text: buffer.text, thinking: buffer.thinking });
        return next;
      }
      return [
        ...current,
        {
          id: buffer.id,
          role: 'assistant',
          text: buffer.text,
          thinking: buffer.thinking,
          timestamp: Date.now(),
        },
      ];
    });
  }, []);

  const sealStreamingBuffer = useCallback(() => {
    flushStreamingBuffer();
    streamingBufferRef.current = null;
  }, [flushStreamingBuffer]);

  // ── Load thread history when the active thread changes ──
  useEffect(() => {
    if (!activeThread) {
      /* eslint-disable react-hooks/set-state-in-effect -- clearing transcript when the active thread is removed must run synchronously to avoid showing stale messages from the previous thread. */
      setTranscript([]);
      setTranscriptLoading(false);
      /* eslint-enable react-hooks/set-state-in-effect */
      streamingBufferRef.current = null;
      return;
    }

    let cancelled = false;
    setTranscriptLoading(true);
    setErrorNote(null);

    fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(activeThread.id)}`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { messages?: ChatHistoryMessage[] };
        if (cancelled) return;
        setTranscript(historyToTranscript(data.messages ?? []));
      })
      .catch((error) => {
        console.log('[mobile-orchestrator] history load failed', error);
        if (!cancelled) {
          setTranscript([]);
          setErrorNote('Unable to load thread history.');
        }
      })
      .finally(() => {
        if (!cancelled) setTranscriptLoading(false);
      });

    streamingBufferRef.current = null;

    return () => {
      cancelled = true;
    };
  }, [activeThread]);

  // ── Subscribe / re-subscribe to orchestrator channel for the active repoPath ──
  const sendSubscription = useCallback((ws: WebSocket | null) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const next = repoPathRef.current;
    const prev = subscribedRepoRef.current;
    if (prev && prev !== next) {
      ws.send(JSON.stringify({ type: 'orchestrator-unsubscribe' }));
      subscribedRepoRef.current = null;
    }
    if (!next) return;
    if (prev !== next) {
      ws.send(JSON.stringify({ type: 'orchestrator-subscribe', repoPath: next }));
      ws.send(JSON.stringify({ type: 'orchestrator-status', repoPath: next }));
      subscribedRepoRef.current = next;
    } else {
      ws.send(JSON.stringify({ type: 'orchestrator-status', repoPath: next }));
    }
  }, []);

  useEffect(() => {
    sendSubscription(wsRef.current);
  }, [activeThread?.repoPath, sendSubscription]);

  // ── WS connection lifecycle ──
  useEffect(() => {
    disposedRef.current = false;
    const url = getWsUrl();
    if (!url) return;

    function handleMessage(event: MessageEvent) {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }

      const channel = raw.channel as string;
      if (channel === 'system' && raw.event === 'connected') {
        setConnectionState('connected');
        backoffRef.current = INITIAL_BACKOFF;
      }
      if (channel !== 'orchestrator') return;

      const eventType = raw.event as string;
      const data = (raw.data as Record<string, unknown> | undefined) ?? {};

      switch (eventType) {
        case 'output': {
          const text = typeof data.text === 'string' ? data.text : '';
          const thinking = data.thinking === true;
          if (!text) return;
          setTurnStatus('busy');
          const buffer = streamingBufferRef.current;
          if (!buffer) {
            streamingBufferRef.current = {
              id: transcriptIdFor('assistant'),
              text,
              thinking,
              flushed: false,
            };
          } else {
            buffer.text = `${buffer.text}${text}`;
            buffer.thinking = thinking;
            buffer.flushed = false;
          }
          break;
        }
        case 'tool-use': {
          const name = typeof data.name === 'string' ? data.name : 'tool';
          // Seal any in-flight assistant buffer so the tool entry slots in
          // after the assistant's prose, not before it.
          sealStreamingBuffer();
          setTranscript((current) => [
            ...current,
            {
              id: transcriptIdFor('tool'),
              role: 'tool',
              text: name,
              toolName: name,
              timestamp: Date.now(),
            },
          ]);
          setTurnStatus('busy');
          break;
        }
        case 'tool-result':
          // Skip — the assistant prose that follows already includes the
          // result narrative. Mobile tab is alpha, no need to render raw
          // tool output.
          break;
        case 'status': {
          const status = data.status;
          if (status === 'ready') {
            sealStreamingBuffer();
            setTurnStatus('idle');
          } else if (status === 'busy') {
            setTurnStatus('busy');
          } else if (status === 'dead') {
            sealStreamingBuffer();
            setTurnStatus('idle');
            setErrorNote('Orchestrator session ended.');
          }
          break;
        }
        case 'error': {
          const message = typeof data.error === 'string' ? data.error : 'Orchestrator error.';
          sealStreamingBuffer();
          setTurnStatus('error');
          setErrorNote(message);
          break;
        }
        default:
          break;
      }
    }

    function connect() {
      if (disposedRef.current) return;
      setConnectionState((prev) => (prev === 'disconnected' ? 'connecting' : 'reconnecting'));
      const ws = new WebSocket(url);

      ws.onopen = () => {
        if (disposedRef.current) {
          ws.close();
          return;
        }
        wsRef.current = ws;
        backoffRef.current = INITIAL_BACKOFF;
        sendSubscription(ws);
        pingTimerRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, PING_INTERVAL);
      };

      ws.onmessage = handleMessage;

      ws.onclose = () => {
        wsRef.current = null;
        subscribedRepoRef.current = null;
        if (pingTimerRef.current) {
          clearInterval(pingTimerRef.current);
          pingTimerRef.current = null;
        }
        if (disposedRef.current) {
          setConnectionState('disconnected');
          return;
        }
        setConnectionState('reconnecting');
        const delay = backoffRef.current;
        backoffRef.current = Math.min(delay * 2, MAX_BACKOFF);
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, delay);
      };

      ws.onerror = () => {
        // onclose follows automatically.
      };
    }

    flushTimerRef.current = setInterval(() => {
      flushStreamingBuffer();
    }, STREAM_FLUSH_MS);

    connect();

    return () => {
      disposedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      if (flushTimerRef.current) {
        clearInterval(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      subscribedRepoRef.current = null;
      setConnectionState('disconnected');
    };
  }, [flushStreamingBuffer, sealStreamingBuffer, sendSubscription]);

  // ── Imperative actions ──
  const sendMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const ws = wsRef.current;
    const repoPath = repoPathRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !repoPath) {
      setErrorNote(repoPath ? 'Not connected — try again in a moment.' : 'Pick a thread with a repo first.');
      return;
    }

    setErrorNote(null);
    setTurnStatus('busy');
    setTranscript((current) => [
      ...current,
      {
        id: transcriptIdFor('user'),
        role: 'user',
        text: trimmed,
        timestamp: Date.now(),
      },
    ]);
    streamingBufferRef.current = null;
    ws.send(JSON.stringify({
      type: 'orchestrator-send',
      repoPath,
      message: trimmed,
      permissionMode: 'full',
    }));
  }, []);

  const interrupt = useCallback(() => {
    const ws = wsRef.current;
    const repoPath = repoPathRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !repoPath) return;
    ws.send(JSON.stringify({ type: 'orchestrator-interrupt', repoPath }));
    setTurnStatus('idle');
    sealStreamingBuffer();
  }, [sealStreamingBuffer]);

  const resetTranscript = useCallback(() => {
    setTranscript([]);
    setErrorNote(null);
    streamingBufferRef.current = null;
  }, []);

  return {
    connectionState,
    turnStatus,
    transcript,
    transcriptLoading,
    errorNote,
    sendMessage,
    interrupt,
    resetTranscript,
  };
}
