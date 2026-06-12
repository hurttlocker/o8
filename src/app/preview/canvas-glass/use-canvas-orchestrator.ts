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

export type CanvasOrchStatus = 'idle' | 'connecting' | 'ready' | 'busy' | 'dead';

/** Thread ids survive reloads — same conversation, same repo, every visit. */
const THREADS_KEY = 'o8:canvas-threads';

function loadThreadMap(): Map<string, string> {
  if (typeof window === 'undefined') return new Map();
  try {
    const raw = window.localStorage.getItem(THREADS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      return new Map(Object.entries(parsed as Record<string, string>).filter(([, value]) => typeof value === 'string'));
    }
  } catch {
    // corrupt entry — start fresh
  }
  return new Map();
}

function saveThreadMap(map: Map<string, string>) {
  try {
    window.localStorage.setItem(THREADS_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // non-critical
  }
}

export interface CanvasOrchCallbacks {
  onOutput?: (repoPath: string, text: string, thinking: boolean) => void;
  onToolUse?: (repoPath: string, name: string) => void;
  onStatus?: (repoPath: string, status: CanvasOrchStatus) => void;
  onError?: (repoPath: string, error: string) => void;
}

export function useCanvasOrchestrator(repoPath: string | null, callbacks: CanvasOrchCallbacks) {
  const wsRef = useRef<WebSocket | null>(null);
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;
  const threadIdsRef = useRef<Map<string, string> | null>(null);
  if (threadIdsRef.current === null) threadIdsRef.current = loadThreadMap();
  const threadIds = threadIdsRef.current;
  const [status, setStatus] = useState<CanvasOrchStatus>('idle');

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
          threadId: threadIds.get(repoPath) ?? null,
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
  }, [repoPath, threadIds]);

  /** Send one user turn. Returns the threadId, or null if the socket
   *  isn't ready (caller surfaces "not connected"). */
  const send = useCallback((message: string, opts?: { model?: string; thinkingEffort?: string }) => {
    if (!repoPath) return null;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    let threadId = threadIds.get(repoPath);
    if (!threadId) {
      threadId = `thoughts-${Date.now()}`;
      threadIds.set(repoPath, threadId);
      saveThreadMap(threadIds);
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
  }, [repoPath, threadIds]);

  const interrupt = useCallback(() => {
    if (!repoPath) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'orchestrator-interrupt',
      repoPath,
      threadId: threadIds.get(repoPath) ?? null,
    }));
  }, [repoPath, threadIds]);

  /** Resume a PAST thread on a repo — history picks route through here.
   *  Re-subscribes the live socket when the repo is the active one. */
  const adoptThread = useCallback((repo: string, threadId: string) => {
    threadIds.set(repo, threadId);
    saveThreadMap(threadIds);
    const ws = wsRef.current;
    if (repo === repoPath && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'orchestrator-subscribe', repoPath: repo, threadId }));
    }
  }, [repoPath, threadIds]);

  return { status, send, interrupt, adoptThread };
}
