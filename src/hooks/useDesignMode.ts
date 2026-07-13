'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Design Mode — the ONE element-grab gesture (browser consolidation, stage 3).
 * Cmd+Shift+D toggles a hover-highlight + click-to-grab overlay that works over
 * the dashboard chrome AND any embedded browser surface (canvas card / Browser
 * tab). The overlay owns the hover/click DOM work; this hook owns only the
 * active flag + the keyboard shortcut. The old region-drag + Cmd+L capture
 * machinery is gone — grabbing is a single click now.
 */
export interface UseDesignModeResult {
  active: boolean;
  toggle: () => void;
  close: () => void;
}

export function useDesignMode(): UseDesignModeResult {
  const [active, setActive] = useState(false);
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const close = useCallback(() => setActive(false), []);
  const toggle = useCallback(() => setActive((current) => !current), []);

  // Broadcast the active state so decoupled surfaces can react — notably
  // NativeBrowserSurface (Stage 4b), which drives the native browser-view's
  // in-page click-to-grab when Design Mode is on (the click lands in that
  // separate OS window, out of this overlay's reach).
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('o8:design-mode', { detail: { active } }));
  }, [active]);

  // Command channel — the browser toolbar's Design button (and any future
  // surface) toggles the mode without prop-drilling from the dashboard
  // (browser toolbelt, Q 2026-07-12).
  useEffect(() => {
    const onRequest = (event: Event) => {
      const action = (event as CustomEvent<{ action?: string }>).detail?.action;
      if (action === 'close') close();
      else if (action === 'open') setActive(true);
      else toggle();
    };
    window.addEventListener('o8:design-mode-request', onRequest);
    return () => window.removeEventListener('o8:design-mode-request', onRequest);
  }, [close, toggle]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (event.metaKey && event.shiftKey && key === 'd') {
        event.preventDefault();
        if (!event.repeat) toggle();
        return;
      }
      if (activeRef.current && event.key === 'Escape') {
        event.preventDefault();
        if (!event.repeat) close();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [close, toggle]);

  return { active, toggle, close };
}
