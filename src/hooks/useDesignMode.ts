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
