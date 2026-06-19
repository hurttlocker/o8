'use client';

import { useEffect, useRef, useState } from 'react';
import {
  applyUiZoom,
  clearUiZoom,
  formatUiZoomPercent,
  persistUiZoom,
  readStoredUiZoom,
  stepUiZoom,
  UI_ZOOM_DEFAULT,
} from '@/lib/appearance/ui-zoom';

/**
 * Mounts the global ⌘- / ⌘= / ⌘+ / ⌘0 zoom for the IDE shell plus a brief
 * percent HUD (the signature native-zoom affordance). Lives once at the
 * dashboard root: applies the persisted zoom to <html> on mount and resets it
 * on unmount so it stays IDE-scoped and never compounds with the canvas route's
 * own zoom. Renders nothing except the transient HUD pill.
 */
export function UiZoomLayer() {
  const [zoom, setZoom] = useState<number>(UI_ZOOM_DEFAULT);
  const [hudVisible, setHudVisible] = useState(false);
  const hudTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const initial = readStoredUiZoom();
    setZoom(initial);
    applyUiZoom(initial);

    const showHud = () => {
      setHudVisible(true);
      if (hudTimer.current) clearTimeout(hudTimer.current);
      hudTimer.current = setTimeout(() => setHudVisible(false), 900);
    };

    const handler = (event: KeyboardEvent) => {
      // Native browser / VSCode zoom binds to ⌘ (Ctrl off-mac) and fires
      // regardless of focus — unlike ⌘K — so we do NOT skip input/textarea.
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key;
      const isOut = key === '-' || key === '_';
      const isIn = key === '=' || key === '+';
      const isReset = key === '0';
      if (!isOut && !isIn && !isReset) return;

      // Block the webview's native zoom before it doubles our scale.
      event.preventDefault();
      event.stopPropagation();

      setZoom((current) => {
        const next = isReset ? UI_ZOOM_DEFAULT : stepUiZoom(current, isIn ? 1 : -1);
        applyUiZoom(next);
        persistUiZoom(next);
        return next;
      });
      showHud();
    };

    // Capture phase so we beat any descendant handler + the native zoom.
    window.addEventListener('keydown', handler, { capture: true });
    return () => {
      window.removeEventListener('keydown', handler, { capture: true });
      if (hudTimer.current) clearTimeout(hudTimer.current);
      clearUiZoom();
    };
  }, []);

  if (!hudVisible) return null;

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        top: 18,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 100000,
        paddingTop: 8,
        paddingBottom: 8,
        paddingLeft: 16,
        paddingRight: 16,
        borderRadius: 14,
        background: 'var(--t-bg-card, rgba(28,28,30,0.92))',
        color: 'var(--t-text, #f5f5f7)',
        border: '1px solid var(--t-border, rgba(255,255,255,0.12))',
        boxShadow: '0 12px 40px rgba(0,0,0,0.32)',
        backdropFilter: 'blur(20px) saturate(160%)',
        WebkitBackdropFilter: 'blur(20px) saturate(160%)',
        fontFamily: 'var(--font-sans-system)',
        fontSize: 13,
        fontWeight: 560,
        letterSpacing: '0.01em',
        fontVariantNumeric: 'tabular-nums',
        pointerEvents: 'none',
        userSelect: 'none',
      } as React.CSSProperties}
    >
      {formatUiZoomPercent(zoom)}
    </div>
  );
}
