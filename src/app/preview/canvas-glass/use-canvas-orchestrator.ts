'use client';

/**
 * useCanvasOrchestrator — the canvas's line to the REAL orchestrator (#1232).
 *
 * Speaks the same ws-server orchestrator channel the OrchestratorTab does
 * (orchestrator-subscribe / -send / -interrupt; output / tool-use / status /
 * error events) through its own socket, scoped to one repo at a time. The
 * production useOrchestratorStream carries the full desktop transcript
 * model; the canvas only needs send → deltas → done, so this stays small.
 *
 * Thread ids are minted per repo (`thoughts-<ts>` — the ws-server persists
 * that prefix to chat history) and kept for the page's lifetime, so
 * switching repos and back resumes the same conversation.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getWsUrl } from '@/components/desktop/thoughts/use-orchestrator-stream/shared';

export type CanvasOrcaStatus = 'idle' | 'connecting' | 'ready' | 'busy' | 'dead';

export interface CanvasOrcaCallbacks {
  onOutput?: (repoPath: string, text: string, thinking: boolean) => void;
  onToolUse?: (repoPath: string, name: string) => void;
  onStatus?: (repoPath: string, status: CanvasOrcaStatus) => void;
  onError?: (repoPath: string, error: string) => void;
}

export function useCanvasOrchestrator(repoPath: string | null, callbacks: CanvasOrcaCallbacks) {
  const wsRef = useRef<WebSocket | null>(null);
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;
  const threadIdsRef = useRef(new Map<string, string>());
  const [status, setStatus] = useState<CanvasOrcaStatus>('idle');

  useEffect(() => {
    if (!repoPath) return;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    setStatus('connecting');

    const connect = () => {
      if (disposed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(getWsUrl());
      } catch {
        retryTimer = setTimeout(connect, 2000);
        return;
      }
      ws.onopen = () => {
        if (disposed) {
          ws.close();
          return;
        }
        wsRef.current = ws;
        ws.send(JSON.stringify({
          type: 'orchestrator-subscribe',
          repoPath,
          threadId: threadIdsRef.current.get(repoPath) ?? null,
        }));
      };
      ws.onmessage = (event) => {
        let msg: { channel?: string; event?: string; data?: Record<string, unknown> };
        try {
          msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
        } catch {
          return;
        }
        if (msg.channel !== 'orchestrator' || !msg.data) return;
        const data = msg.data;
        if (msg.event === 'output' && typeof data.text === 'string') {
          cbRef.current.onOutput?.(repoPath, data.text, data.thinking === true);
        } else if (msg.event === 'tool-use' && typeof data.name === 'string') {
          cbRef.current.onToolUse?.(repoPath, data.name);
        } else if (msg.event === 'status' && typeof data.status === 'string') {
          const next = data.status === 'busy' ? 'busy' : data.status === 'dead' ? 'dead' : 'ready';
          setStatus(next);
          cbRef.current.onStatus?.(repoPath, next);
        } else if (msg.event === 'error' && typeof data.error === 'string') {
          cbRef.current.onError?.(repoPath, data.error);
        }
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (!disposed) {
          setStatus('connecting');
          retryTimer = setTimeout(connect, 2000);
        }
      };
      ws.onerror = () => { /* onclose retries */ };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      wsRef.current?.close();
      wsRef.current = null;
      setStatus('idle');
    };
  }, [repoPath]);

  /** Send one user turn. Returns the threadId, or null if the socket
   *  isn't ready (caller surfaces "not connected"). */
  const send = useCallback((message: string, opts?: { model?: string; thinkingEffort?: string }) => {
    if (!repoPath) return null;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    let threadId = threadIdsRef.current.get(repoPath);
    if (!threadId) {
      threadId = `thoughts-${Date.now()}`;
      threadIdsRef.current.set(repoPath, threadId);
    }
    ws.send(JSON.stringify({
      type: 'orchestrator-send',
      repoPath,
      threadId,
      message,
      permissionMode: 'full',
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.thinkingEffort && opts.thinkingEffort !== 'adaptive' ? { thinkingEffort: opts.thinkingEffort } : {}),
    }));
    return threadId;
  }, [repoPath]);

  const interrupt = useCallback(() => {
    if (!repoPath) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'orchestrator-interrupt',
      repoPath,
      threadId: threadIdsRef.current.get(repoPath) ?? null,
    }));
  }, [repoPath]);

  return { status, send, interrupt };
}
