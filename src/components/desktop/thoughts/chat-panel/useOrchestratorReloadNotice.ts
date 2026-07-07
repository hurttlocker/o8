/**
 * Listens for orchestrator `notice` events (for example kind="mcp-reload")
 * dispatched by useOrchestratorStream / socket.ts and exposes banner props
 * the chat panel can render without leaking this concern into
 * ThoughtsChatPanel (which is already over the 800-line file ceiling).
 *
 * The upstream event rides the orchestrator WS channel as:
 *
 *   { channel: 'orchestrator', event: 'notice',
 *     data: { kind: 'mcp-reload', noticeId, message, registered, repoPath } }
 *
 * and is re-dispatched as a window `cortex:orchestrator-notice` CustomEvent.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { RELOAD_BANNER_AUTO_DISMISS_MS } from './ReloadBanner';

export interface OrchestratorReloadNotice {
  noticeId: string;
  kind: 'mcp-reload' | 'cross-house-orchestrator-handoff';
  message: string;
  registered: string[];
  repoPath: string | null;
  autoDismiss: boolean;
  receivedAt: number;
}

interface NoticeDetail {
  kind?: string;
  noticeId?: string;
  message?: string;
  registered?: unknown;
  repoPath?: string;
}

function normalize(detail: NoticeDetail): OrchestratorReloadNotice | null {
  if (detail.kind !== 'mcp-reload' && detail.kind !== 'cross-house-orchestrator-handoff') return null;
  const noticeId = typeof detail.noticeId === 'string' ? detail.noticeId.trim() : '';
  if (!noticeId) return null;
  const message = typeof detail.message === 'string' && detail.message.trim()
    ? detail.message.trim()
    : detail.kind === 'cross-house-orchestrator-handoff'
      ? 'Claude subscription exhausted — Codex is acting orchestrator.'
      : 'Reloading with new MCP tools…';
  const registered = Array.isArray(detail.registered)
    ? detail.registered.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const repoPath = typeof detail.repoPath === 'string' ? detail.repoPath : null;
  return {
    noticeId,
    kind: detail.kind,
    message,
    registered,
    repoPath,
    autoDismiss: detail.kind === 'mcp-reload',
    receivedAt: Date.now(),
  };
}

export interface UseOrchestratorReloadNoticeResult {
  notice: OrchestratorReloadNotice | null;
  dismiss: () => void;
}

export function useOrchestratorReloadNotice(
  repoPath?: string | null,
): UseOrchestratorReloadNoticeResult {
  const [notice, setNotice] = useState<OrchestratorReloadNotice | null>(null);

  const dismiss = useCallback(() => {
    setNotice(null);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const handler = (event: Event) => {
      const custom = event as CustomEvent<NoticeDetail>;
      const next = normalize(custom.detail ?? {});
      if (!next) return;
      // Only show banners for the currently-active repo. If the caller
      // doesn't scope by repo (no repoPath prop), accept everything.
      if (repoPath && next.repoPath && next.repoPath !== repoPath) return;
      setNotice(next);
    };

    window.addEventListener('cortex:orchestrator-notice', handler);
    return () => {
      window.removeEventListener('cortex:orchestrator-notice', handler);
    };
  }, [repoPath]);

  // Safety net for transient reload notices. Cross-house handoffs are durable:
  // the operator must see and dismiss that stand-in card explicitly.
  useEffect(() => {
    if (!notice?.autoDismiss) return undefined;
    const timer = window.setTimeout(() => {
      setNotice((current) => (current && current.noticeId === notice.noticeId ? null : current));
    }, RELOAD_BANNER_AUTO_DISMISS_MS + 500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return { notice, dismiss };
}
