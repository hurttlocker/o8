'use client';

/**
 * ConnectionPill — slim reconnect indicator for the AgentPanel bottom
 * slot. Replaces the old full-width "Reconnecting to workspace runtime"
 * banner at the top of the workspace.
 *
 * Stacks with UpdateCard:
 *   - WS connected, no update     → both hidden
 *   - WS disconnected only        → ConnectionPill alone in the slot
 *   - update only                 → UpdateCard alone
 *   - WS disconnected + update    → ConnectionPill above UpdateCard
 *
 * Click "Reload" to bounce the window (cheaper than re-plumbing the
 * imperative reconnect handle through the provider, same pattern as
 * the old ConnectionBanner).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { RealtimeEventEnvelope, RealtimeMutationRecord } from '@/lib/realtime/types';
import { useSharedDesktopWs, useWsConnectionState } from './hooks/DesktopWebSocketContext';

const SHOW_AFTER_MS = 2_000;

export function ConnectionPill() {
  const connectionState = useWsConnectionState();
  const everConnectedRef = useRef(false);
  const [visible, setVisible] = useState(false);
  const [downBridges, setDownBridges] = useState<Set<string>>(() => new Set());
  const bridgeDown = downBridges.size > 0;
  const downSinceRef = useRef<number | null>(null);

  useSharedDesktopWs(undefined, useMemo(() => ({
    onRealtimeEvent: (event: RealtimeEventEnvelope) => {
      if (event.channel !== 'mutation' || event.event !== 'mutation.record') return;
      const mutation = (event.data as { mutation?: RealtimeMutationRecord }).mutation;
      if (mutation?.action !== 'realtime-bridge-connection') return;
      setDownBridges((current) => {
        const next = new Set(current);
        const channel = mutation.runtime ?? 'realtime';
        if (mutation.status === 'failed') next.add(channel);
        else if (mutation.status === 'completed') next.delete(channel);
        return next.size === current.size && [...next].every((entry) => current.has(entry)) ? current : next;
      });
    },
  }), []));

  /* eslint-disable react-hooks/set-state-in-effect -- canonical pattern
     for "synchronize internal UI state to an external prop". */
  useEffect(() => {
    if (connectionState === 'connected' && !bridgeDown) {
      everConnectedRef.current = true;
      downSinceRef.current = null;
      setVisible(false);
    }
  }, [bridgeDown, connectionState]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!everConnectedRef.current) return undefined;
    if (bridgeDown && connectionState === 'connected') {
      const showTimer = window.setTimeout(() => setVisible(true), 0);
      return () => window.clearTimeout(showTimer);
    }
    if (connectionState !== 'reconnecting' && connectionState !== 'disconnected') {
      return undefined;
    }
    if (downSinceRef.current === null) {
      downSinceRef.current = Date.now();
    }
    const showTimer = window.setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => window.clearTimeout(showTimer);
  }, [bridgeDown, connectionState]);

  const handleReload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  if (!visible) return null;

  const isBridgeOnly = bridgeDown && connectionState === 'connected';
  const isOffline = connectionState === 'disconnected';
  const accent = isOffline ? '#ef4444' : '#f97316';
  const label = isBridgeOnly ? 'Updates reconnecting…' : isOffline ? 'Backend offline' : 'Reconnecting…';

  const cardStyle: CSSProperties = {
    flexShrink: 0,
    marginLeft: 8,
    marginRight: 8,
    marginBottom: 6,
    paddingTop: 6,
    paddingRight: 10,
    paddingBottom: 6,
    paddingLeft: 11,
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    borderRadius: 10,
    border: '1px solid var(--t-divider-subtle)',
    background: 'var(--t-bg-card, var(--t-panel-solid))',
    boxShadow: '0 4px 14px rgba(15, 23, 42, 0.06)',
    fontFamily: 'var(--font-sans-system)',
    color: 'var(--t-text)',
  };

  return (
    <div role="status" aria-live="polite" style={cardStyle}>
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: accent,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            color: 'var(--t-text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {label}
        </span>
      </div>
      <button
        type="button"
        onClick={handleReload}
        style={{
          flexShrink: 0,
          height: 20,
          paddingLeft: 6,
          paddingRight: 6,
          paddingTop: 0,
          paddingBottom: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          lineHeight: 1,
          borderRadius: 6,
          border: 'none',
          background: 'transparent',
          color: accent,
          fontSize: 11,
          fontWeight: 400,
          letterSpacing: '-0.1px',
          fontFamily: 'inherit',
          cursor: 'pointer',
        }}
      >
        Reload
      </button>
    </div>
  );
}
