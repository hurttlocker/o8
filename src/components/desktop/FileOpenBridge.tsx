'use client';

/**
 * FileOpenBridge — routes Finder "Open With → o8" / dock-drop file opens
 * to the canvas, the surface that renders them as file cards (#1232/#1235).
 * Mounted on the dashboard. Peeks (never takes) the pending buffer so the
 * navigation can't lose paths — the canvas page does the actual drain.
 * Inert outside Tauri or while the canvas flag is off.
 */

import { useEffect } from 'react';
import { useExperimentalCanvasFlag } from '@/lib/operator/use-experimental-canvas';
import { isTauri, onFileOpenRequest, peekPendingFileOpens } from '@/lib/tauri/bridge';

export function FileOpenBridge() {
  const canvasEnabled = useExperimentalCanvasFlag();

  useEffect(() => {
    if (!canvasEnabled || !isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const goCanvas = () => {
      window.location.assign('/preview/canvas-glass');
    };
    // Cold launch: the OS handed us files before any page was listening.
    void peekPendingFileOpens().then((paths) => {
      if (!disposed && paths.length > 0) goCanvas();
    });
    // Warm: o8 already running when the user picked "Open With → o8".
    void onFileOpenRequest(() => goCanvas()).then((dispose) => {
      if (disposed) dispose?.();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [canvasEnabled]);

  return null;
}
