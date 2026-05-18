'use client';

/**
 * ConnectionBanner — slim banner above the TitleBar that surfaces a dropped
 * WebSocket connection. Visibility rules:
 *   - Hidden on first mount until the WS has been open at least once (avoids
 *     cold-boot flicker while ws-server warms up).
 *   - Once we have seen a 'connected' state, any subsequent transition to
 *     'reconnecting' or 'disconnected' shows the banner after a 2s grace.
 *   - Hides immediately on reconnect.
 *
 * "Retry now" reloads the window — cheaper than re-plumbing an imperative
 * reconnect handle through the provider for one UI.
 */

import { memo, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
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

  /* eslint-disable react-hooks/set-state-in-effect -- the canonical pattern
     for "synchronize internal UI state to an external prop". */
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

  const isOffline = connectionState === 'disconnected';
  const label = isOffline ? 'Backend unreachable' : 'Reconnecting';
  const subline = secondsDown > 2
    ? `Paused for ${formatSeconds(secondsDown)} · retrying with backoff`
    : 'Live updates paused · retrying with backoff';

  const accent = isOffline ? '#ef4444' : '#f97316';

  const handleRetry = () => {
    if (typeof window !== 'undefined') {
      console.info('[error-state] User clicked retry on ConnectionBanner — reloading window');
      window.location.reload();
    }
  };

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.div
          role="status"
          aria-live="polite"
          initial={{ height: 0, opacity: 0, y: -8 }}
          animate={{ height: 'auto', opacity: 1, y: 0 }}
          exit={{ height: 0, opacity: 0, y: -8 }}
          transition={{ type: 'spring', stiffness: 380, damping: 32, mass: 0.6 }}
          style={{
            overflow: 'hidden',
            zIndex: 9100,
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              paddingTop: 8,
              paddingRight: 14,
              paddingBottom: 8,
              paddingLeft: 14,
              background: 'var(--t-panel)',
              backdropFilter: 'saturate(180%) blur(20px)',
              WebkitBackdropFilter: 'saturate(180%) blur(20px)',
              borderBottom: `0.5px solid ${withAlpha(accent, 0.22)}`,
              color: 'var(--t-text)',
            }}
          >
            <StatusDot color={accent} />

            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flex: 1, minWidth: 0 }}>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: '-0.01em',
                  color: 'var(--t-text)',
                  whiteSpace: 'nowrap',
                  display: 'inline-flex',
                  alignItems: 'baseline',
                  gap: 2,
                }}
              >
                {label}
                {!isOffline ? <BreathingDots color={accent} /> : null}
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 400,
                  color: 'var(--t-text-muted)',
                  letterSpacing: '-0.005em',
                  fontVariantNumeric: 'tabular-nums',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {subline}
              </span>
            </div>

            <motion.button
              type="button"
              onClick={handleRetry}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 480, damping: 22, mass: 0.5 }}
              style={{
                height: 28,
                paddingLeft: 12,
                paddingRight: 12,
                borderRadius: 9,
                border: `0.5px solid ${withAlpha(accent, 0.32)}`,
                background: withAlpha(accent, 0.10),
                color: accent,
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: '-0.005em',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              Retry now
            </motion.button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function StatusDot({ color }: { color: string }) {
  return (
    <span style={{ position: 'relative', width: 10, height: 10, flexShrink: 0 }}>
      <motion.span
        aria-hidden
        animate={{ scale: [1, 1.9, 1], opacity: [0.45, 0, 0.45] }}
        transition={{ duration: 1.6, ease: 'easeOut', repeat: Infinity }}
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 999,
          background: color,
        }}
      />
      <span
        style={{
          position: 'absolute',
          inset: 1,
          borderRadius: 999,
          background: color,
          boxShadow: `0 0 0 0.5px ${withAlpha(color, 0.55)} inset`,
        }}
      />
    </span>
  );
}

function BreathingDots({ color }: { color: string }) {
  return (
    <span aria-hidden style={{ display: 'inline-flex', gap: 2, marginLeft: 4, marginBottom: 1 }}>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.18, ease: 'easeInOut' }}
          style={{
            width: 3,
            height: 3,
            borderRadius: 999,
            background: color,
            display: 'inline-block',
          }}
        />
      ))}
    </span>
  );
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining.toString().padStart(2, '0')}s`;
}

export const ConnectionBanner = memo(ConnectionBannerBase);
