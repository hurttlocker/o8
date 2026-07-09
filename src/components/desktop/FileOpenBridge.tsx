'use client';

/**
 * FileOpenBridge — routes Finder "Open With → o8" / dock-drop file opens to the
 * right o8 surface. The OS delivers opens through RunEvent::Opened in
 * src-tauri/src/lib.rs, which BUFFERS the paths (take/peek_pending_file_opens)
 * and emits a live `file-open-request` event. This component is the single
 * dashboard-side router for both.
 *
 * Routing rule (one flag decides — kept deliberately simple):
 *   • experimentalCanvas ON  → the canvas page renders opens as file cards.
 *     Navigate there and let it DRAIN the buffer (peek here, never take, so the
 *     navigation can't lose paths — the canvas page does the real take).
 *   • experimentalCanvas OFF → the dashboard IS the surface. DRAIN the buffer
 *     here (take) and hand each path to onOpenFile, which pops it open as a tab
 *     in the workspace. This is the default IDE experience.
 *
 * The canvas and the dashboard are separate routes, so only the mounted one's
 * listener ever fires — the active surface wins for free, no cross-talk.
 *
 * Cold launch is dashboard-default by design: on a fresh process the flag reads
 * false until its async fetch resolves, so the buffered opens drain to the
 * workspace here. (The operator spec pins cold launch to "dashboard default";
 * the canvas file-card path owns the warm case, when the user is already on the
 * canvas route.) The tab open awaits the workspace target, so it lands AFTER
 * hydration, never before.
 *
 * Inert outside Tauri. Mounted once on the dashboard.
 */

import { useEffect } from 'react';
import { useExperimentalCanvasFlag } from '@/lib/operator/use-experimental-canvas';
import { isTauri, onFileOpenRequest, peekPendingFileOpens, takePendingFileOpens } from '@/lib/tauri/bridge';

export function FileOpenBridge({ onOpenFile }: { onOpenFile?: (path: string) => void }) {
  const canvasEnabled = useExperimentalCanvasFlag();

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    if (canvasEnabled) {
      // Canvas surface: navigate and let the canvas page drain (peek, never take).
      const goCanvas = () => window.location.assign('/preview/canvas-glass');
      // Cold launch: the OS handed us files before any page was listening.
      void peekPendingFileOpens().then((paths) => {
        if (!disposed && paths.length > 0) goCanvas();
      });
      // Warm: o8 already running when the user picked "Open With → o8".
      void onFileOpenRequest(() => { if (!disposed) goCanvas(); }).then((dispose) => {
        if (disposed) dispose?.(); else unlisten = dispose;
      });
    } else {
      // Dashboard/IDE surface: drain the buffer here (take) and open each path
      // as a workspace tab. The event is only a trigger — the buffer is the
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
    }

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [canvasEnabled, onOpenFile]);

  return null;
}
