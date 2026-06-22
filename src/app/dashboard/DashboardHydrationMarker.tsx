'use client';

import { useEffect } from 'react';

// The pre-ship boot gate (scripts/preship-webview-gate.mjs) treats
// `data-o8-dashboard-hydrated` as proof the dashboard booted cleanly. We only
// stamp it once the workspace subtree has actually PAINTED — i.e. the
// [data-o8-workspace] anchor (TileContainer's root) exists with a real box —
// not merely once an effect ran. A white-screen or empty render that never
// throws therefore cannot report healthy, and a route-boundary mount error
// (data-o8-mount-error) suppresses it outright.
export function DashboardHydrationMarker() {
  useEffect(() => {
    const root = document.documentElement;
    root.removeAttribute('data-o8-dashboard-hydrated');

    let raf = 0;
    let frames = 0;
    // ~10s ceiling at 60fps — far above the gate's own 60s health deadline, so
    // the gate owns the timeout; we just refuse to claim health before paint.
    const MAX_FRAMES = 600;

    const check = () => {
      if (root.getAttribute('data-o8-mount-error') === '1') return; // crashed — stay silent
      const ws = document.querySelector('[data-o8-workspace]');
      const painted = ws instanceof HTMLElement && ws.offsetHeight > 0 && ws.offsetWidth > 0;
      if (painted) {
        root.setAttribute('data-o8-dashboard-hydrated', '1');
        return;
      }
      if (frames++ < MAX_FRAMES) {
        raf = window.requestAnimationFrame(check);
      }
    };
    raf = window.requestAnimationFrame(check);

    return () => window.cancelAnimationFrame(raf);
  }, []);

  return null;
}
