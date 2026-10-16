'use client';

import { useEffect, useState } from 'react';

/** Expand within the workspace region while keeping the chat and panel mounted. */
export function useRightPanelMaximize(visible: boolean) {
  const [state, setState] = useState({ visible, requested: false });
  // Reset alongside a visibility change, before rendering another frame.
  if (state.visible !== visible) setState({ visible, requested: visible && state.requested });
  const maximized = visible && state.requested;
  useEffect(() => {
    if (!maximized) return;
    const restore = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const overlay = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [data-composer-overlay]')].some((node) => {
        for (let current: HTMLElement | null = node; current; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
        }
        return true;
      });
      if (overlay) return;
      event.preventDefault(); setState((current) => ({ ...current, requested: false }));
      document.querySelector<HTMLElement>('[aria-label="Restore panel size"]')?.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', restore);
    return () => document.removeEventListener('keydown', restore);
  }, [maximized]);
  return { maximized, toggleMaximized: () => setState((current) => ({ visible, requested: visible && !current.requested })) };
}
