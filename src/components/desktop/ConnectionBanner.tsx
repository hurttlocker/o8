'use client';

/**
 * ConnectionBanner — slim banner above the TitleBar that surfaces a dropped
 * WebSocket connection so the user knows why agent statuses, transcripts, and
 * approvals appear frozen. Hooks the existing reconnect/backoff machinery in
 * DesktopWebSocketContext (which already retries with exponential backoff up
 * to 30s) — this component only adds the chrome surface.
 *
 * Visibility rules:
 *   - Hidden on first mount until the WS has been open at least once. This
 *     avoids flickering on cold-boot when the ws-server is still warming up.
 *   - Once we have seen a 'connected' state, any subsequent transition to
 *     'reconnecting' or 'disconnected' shows the banner after a 2s grace.
 *   - The banner hides immediately on reconnect.
 *
 * The "Retry" button reloads the window — the dashboard tears down and the
 * Tauri shell rebuilds the connection from scratch. Cheaper than re-plumbing
 * an imperative reconnect handle through the provider just for this one UI.
 *
 * Inline styles only per the repo's no-CSS-classes rule.
 */

import { memo, useEffect, useRef, useState } from 'react';
import type { WsConnectionState } from './hooks/DesktopWebSocketContext';

const SHOW_AFTER_MS = 2_000;

interface ConnectionBannerProps {
  connectionState: WsConnectionState;
}

function ConnectionBannerBase({ connectionState }: ConnectionBannerProps) {
  const everConnectedRef = useRef(false);
  const [visible, setVisible] = useState(false);
  const [secondsDown, setSecondsDown] = useState(0);
  const downSinceRef = useRef<number | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect -- this effect is the canonical
     React-recommended pattern for "synchronize internal UI state to an external
     prop" (the WS connection state from the shared provider). Hiding the banner
     on reconnect is a one-shot transition, not a render-time computation. */
  useEffect(() => {
    if (connectionState === 'connected') {
      everConnectedRef.current = true;
      downSinceRef.current = null;
      setVisible(false);
      setSecondsDown(0);
    }
  }, [connectionState]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!everConnectedRef.current) return undefined;
    if (connectionState !== 'reconnecting' && connectionState !== 'disconnected') {
      return undefined;
    }
    if (downSinceRef.current === null) {
      downSinceRef.current = Date.now();
    }
    const showTimer = window.setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    const tickTimer = window.setInterval(() => {
      if (downSinceRef.current === null) return;
      setSecondsDown(Math.max(0, Math.floor((Date.now() - downSinceRef.current) / 1000)));
    }, 1000);
    return () => {
      window.clearTimeout(showTimer);
      window.clearInterval(tickTimer);
    };
  }, [connectionState]);

  if (!visible) return null;

  const label = connectionState === 'disconnected'
    ? 'Backend unreachable'
    : 'Reconnecting to backend…';

  const handleRetry = () => {
    if (typeof window !== 'undefined') {
      console.info('[error-state] User clicked retry on ConnectionBanner — reloading window');
      window.location.reload();
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        paddingTop: 8,
        paddingRight: 16,
        paddingBottom: 8,
        paddingLeft: 16,
        background: 'linear-gradient(135deg, rgba(249, 115, 22, 0.10), rgba(239, 68, 68, 0.10))',
        borderBottom: '1px solid rgba(249, 115, 22, 0.20)',
        fontSize: 13,
        color: 'var(--t-text)',
        zIndex: 9100,
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
      }}
    >
      <svg
        width={14}
        height={14}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#f97316"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, animation: 'spin 1.6s linear infinite' }}
        aria-hidden="true"
      >
        <path d="M21 12a9 9 0 11-6.219-8.56" />
      </svg>
      <span style={{ flex: 1, fontWeight: 500, color: 'var(--t-text)' }}>
        <strong style={{ fontWeight: 600 }}>{label}</strong>
        {secondsDown > 2 ? (
          <span style={{ marginLeft: 8, color: 'var(--t-text-muted)', fontWeight: 400 }}>
            {`Live updates paused for ${formatSeconds(secondsDown)}. Backoff retries automatically.`}
          </span>
        ) : (
          <span style={{ marginLeft: 8, color: 'var(--t-text-muted)', fontWeight: 400 }}>
            Live updates paused. Backoff retries automatically.
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={handleRetry}
        style={{
          paddingTop: 4,
          paddingRight: 12,
          paddingBottom: 4,
          paddingLeft: 12,
          borderRadius: 8,
          border: '1px solid rgba(249, 115, 22, 0.30)',
          background: 'rgba(249, 115, 22, 0.08)',
          color: '#c2410c',
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Retry now
      </button>
    </div>
  );
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining.toString().padStart(2, '0')}s`;
}

export const ConnectionBanner = memo(ConnectionBannerBase);
