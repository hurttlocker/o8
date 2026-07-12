'use client';

/**
 * FileOpenBridge — routes Finder "Open With → o8" / dock-drop file opens to the
 * right o8 surface. The OS delivers opens through RunEvent::Opened in
 * src-tauri/src/lib.rs, which BUFFERS the paths (take/peek_pending_file_opens)
 * and emits a live `file-open-request` event. This component is the single
 * dashboard-side router for both.
 *
 * Routing rule: THE MOUNTED SURFACE WINS. This bridge lives on the dashboard,
 * so if it's listening, the operator is ON the dashboard — drain the buffer
 * (take) and hand each path to onOpenFile, whose surface-aware routing (Q
 * ruling 2026-07-11 in dashboard/page.tsx) opens it in the right-panel Files
 * view on the IDE side or as a canvas tab when the center is a canvas. The
 * canvas PAGE (/preview/canvas-glass) has its own drain for when the operator
 * is actually there — separate routes, only one listener mounted at a time.
 *
 * The old experimentalCanvas branch that NAVIGATED to the canvas page from
 * here is deleted (Q live-hit 2026-07-12: Finder-open hijacked him off the
 * dashboard into canvas). A feature flag says the surface exists, not that
 * the operator is on it.
 *
 * Cold launch lands on the dashboard by design, so buffered opens drain to
 * the workspace here. The tab open awaits the workspace target, so it lands
 * AFTER hydration, never before. Inert outside Tauri. Mounted once.
 */

import { useEffect } from 'react';
import { isTauri, onFileOpenRequest, takePendingFileOpens } from '@/lib/tauri/bridge';

export function FileOpenBridge({ onOpenFile }: { onOpenFile?: (path: string) => void }) {
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    // Drain the buffer (take) — the event is only a trigger; the buffer is the
    // source of truth, so warm events re-drain too (mirrors the canvas page).
    const drain = () => {
      void takePendingFileOpens().then((paths) => {
        if (disposed) return;
        paths.forEach((path) => { if (path) onOpenFile?.(path); });
      });
    };
    drain();
    void onFileOpenRequest(() => { if (!disposed) drain(); }).then((dispose) => {
      if (disposed) dispose?.(); else unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onOpenFile]);

  return null;
}
