'use client';

/**
 * BrowserPipCard — floating browser picture-in-picture (Codex borrow,
 * operator ask 2026-07-31). When NO side panel is open, hovering a browser
 * tool cluster in the transcript floats a live, mobile-aspect preview of the
 * current browser tab, viewport-anchored top-right — the operator sees what
 * the agent is building without giving up the full-width transcript.
 *
 * Mechanics from the reference video (verbatim borrow notes):
 * - trigger from context (the whole tool cluster, not a tiny pill target)
 * - viewport-anchored, never follows the hovered row
 * - stays alive while the pointer is on the trigger OR the card itself
 * - fast fade+scale (≤200ms), X + pop-out controls on the card
 *
 * Emitters dispatch BROWSER_PIP_EVENT with { hovering } — see
 * ToolCallChipCluster. The card owns all dwell/grace timing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { NativeBrowserSurface } from '@/components/desktop/NativeBrowserSurface';
import { useO8BrowserTabs } from '@/components/desktop/use-o8-browser-tabs';
import { useNativeBrowserViewFlag } from '@/lib/operator/use-native-browser-view';
import { isTauri } from '@/lib/tauri/bridge';

export const BROWSER_PIP_EVENT = 'o8:browser-pip';

const FONT = 'var(--font-sans-system)';
const CARD_WIDTH = 300;
const FRAME_HEIGHT = 470;
const OPEN_DWELL_MS = 240;
const CLOSE_GRACE_MS = 200;
/** Fallback iframe renders at a real phone viewport, scaled to the card. */
const MOBILE_VIEWPORT_WIDTH = 390;

function PopOutGlyph() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14L21 3" />
    </svg>
  );
}

export function BrowserPipCard({
  active,
  scopeKey,
  onOpenBrowser,
}: {
  /** No side panel is open — the only mode where the PIP earns its place. */
  active: boolean;
  /** MUST match the dashboard's browser tab-store scope (right-panel:<repo>). */
  scopeKey: string;
  onOpenBrowser?: () => void;
}) {
  const tabs = useO8BrowserTabs(scopeKey);
  const [inTauri] = useState<boolean>(() => isTauri());
  const nativeEnabled = useNativeBrowserViewFlag() && inTauri;
  const [visible, setVisible] = useState(false);
  const cardHoverRef = useRef(false);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current) window.clearTimeout(openTimerRef.current);
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    openTimerRef.current = null;
    closeTimerRef.current = null;
  }, []);

  const scheduleClose = useCallback(() => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      if (!cardHoverRef.current) setVisible(false);
    }, CLOSE_GRACE_MS);
  }, []);

  useEffect(() => {
    const onPipHover = (event: Event) => {
      const hovering = Boolean((event as CustomEvent<{ hovering?: boolean }>).detail?.hovering);
      if (hovering) {
        clearTimers();
        openTimerRef.current = window.setTimeout(() => setVisible(true), OPEN_DWELL_MS);
      } else {
        if (openTimerRef.current) window.clearTimeout(openTimerRef.current);
        openTimerRef.current = null;
        scheduleClose();
      }
    };
    window.addEventListener(BROWSER_PIP_EVENT, onPipHover);
    return () => {
      window.removeEventListener(BROWSER_PIP_EVENT, onPipHover);
      clearTimers();
    };
  }, [clearTimers, scheduleClose]);

  const tab = tabs[0] ?? null;
  const show = active && visible && Boolean(tab);
  const iframeScale = CARD_WIDTH / MOBILE_VIEWPORT_WIDTH;

  return (
    <AnimatePresence>
      {show && tab ? (
        <motion.div
          key="browser-pip"
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
          onMouseEnter={() => {
            cardHoverRef.current = true;
            if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
          }}
          onMouseLeave={() => {
            cardHoverRef.current = false;
            scheduleClose();
          }}
          style={{
            position: 'fixed',
            top: 52,
            right: 16,
            width: CARD_WIDTH,
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 14,
            overflow: 'hidden',
            background: 'var(--t-panel-solid, var(--t-panel))',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-panel-border)',
            boxShadow: 'var(--t-panel-shadow, 0 12px 32px rgba(0, 0, 0, 0.25))',
            fontFamily: FONT,
            transformOrigin: 'top right',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 30, paddingLeft: 10, paddingRight: 4 }}>
            <span
              title={tab.url}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 10.5,
                fontWeight: 300,
                letterSpacing: '-0.1px',
                color: 'var(--t-text-muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {tab.title || tab.host || tab.url}
            </span>
            <button
              type="button"
              aria-label="Open in Browser tab"
              title="Open in Browser tab"
              onClick={() => {
                setVisible(false);
                onOpenBrowser?.();
              }}
              style={{
                flexShrink: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 24,
                height: 24,
                borderWidth: 0,
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--t-text-faint)',
                cursor: 'pointer',
              }}
            >
              <PopOutGlyph />
            </button>
            <button
              type="button"
              aria-label="Close preview"
              title="Close preview"
              onClick={() => setVisible(false)}
              style={{
                flexShrink: 0,
                minWidth: 24,
                minHeight: 24,
                borderWidth: 0,
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--t-text-faint)',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 300,
                fontFamily: FONT,
              }}
            >
              ×
            </button>
          </div>
          <div style={{ position: 'relative', height: FRAME_HEIGHT, overflow: 'hidden', background: 'var(--t-canvas-bg)' }}>
            {nativeEnabled ? (
              <NativeBrowserSurface url={tab.url} />
            ) : (
              <>
                <iframe
                  src={tab.url}
                  title="Browser preview"
                  sandbox="allow-scripts allow-same-origin allow-forms"
                  style={{
                    width: MOBILE_VIEWPORT_WIDTH,
                    height: FRAME_HEIGHT / iframeScale,
                    borderWidth: 0,
                    transform: `scale(${iframeScale})`,
                    transformOrigin: '0 0',
                    pointerEvents: 'none',
                  } as React.CSSProperties}
                />
                <button
                  type="button"
                  aria-label="Open browser tab"
                  onClick={() => {
                    setVisible(false);
                    onOpenBrowser?.();
                  }}
                  style={{
                    position: 'absolute',
                    top: 0,
                    right: 0,
                    bottom: 0,
                    left: 0,
                    borderWidth: 0,
                    background: 'transparent',
                    cursor: 'pointer',
                  }}
                />
              </>
            )}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
