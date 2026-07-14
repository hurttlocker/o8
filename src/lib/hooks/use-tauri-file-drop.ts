'use client';

import { useEffect, useRef, useState } from 'react';
import { canUseTauriEvents } from '@/lib/tauri/bridge';

export interface TauriDropClientCoords {
  x: number;
  y: number;
}

export interface UseTauriFileDropOptions {
  /**
   * The element to hit-test drops against. When the drop position lands
   * inside this element's bounding rect, the hook fires onDrop and toggles
   * dragOver for hover affordance. Pass null/undefined ref to disable
   * hit-testing entirely and accept every drop.
   */
  hostRef: React.RefObject<HTMLElement | null>;
  onDrop: (paths: string[], clientCoords: TauriDropClientCoords) => void;
  /**
   * When true, accept drops anywhere in the window (skip hit-test). Useful
   * for fullscreen overlays or modes with no clear DOM bounds. Defaults
   * to false.
   */
  acceptAll?: boolean;
  /** When true, ignores Tauri drag-drop events entirely. */
  disabled?: boolean;
}

export interface UseTauriFileDropResult {
  /** True while a drag is hovering inside hostRef (or anywhere if acceptAll). */
  dragOver: boolean;
}

interface DragEventPayload {
  paths?: string[];
  position?: { x: number; y: number };
}

/**
 * Low-level primitive that subscribes to the Rust drag-drop bridge
 * (src-tauri/src/lib.rs::on_window_event, gated on
 * `dragDropEnabled: true` in tauri.conf.json).
 *
 * Use directly for surfaces with no HTML5 fallback (terminal, Monaco).
 * For composers that already have a HTML5 fallback path, prefer the
 * higher-level `useFileDrop` hook — it integrates this bridge with the
 * existing pendingFiles state machine.
 */
export function useTauriFileDrop({
  hostRef,
  onDrop,
  acceptAll = false,
  disabled = false,
}: UseTauriFileDropOptions): UseTauriFileDropResult {
  const [dragOver, setDragOver] = useState(false);
  // Keep latest onDrop in a ref so the listener subscription doesn't churn.
  const onDropRef = useRef(onDrop);
  useEffect(() => {
    onDropRef.current = onDrop;
  }, [onDrop]);

  useEffect(() => {
    if (disabled) return undefined;
    if (typeof window === 'undefined') return undefined;
    // Event listeners only in the main window — a main-app page mounted in the
    // native browser-view would ACL-crash on emit/listen (see canUseTauriEvents).
    if (!canUseTauriEvents()) return undefined;

    let mounted = true;
    const unlistens: Array<() => void> = [];

    const hit = (
      physX: number,
      physY: number,
    ): { ok: boolean; clientX: number; clientY: number } => {
      const dpr = window.devicePixelRatio || 1;
      const clientX = physX / dpr;
      const clientY = physY / dpr;
      if (acceptAll) return { ok: true, clientX, clientY };
      const el = hostRef.current;
      if (!el) return { ok: false, clientX, clientY };
      const rect = el.getBoundingClientRect();
      const ok =
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom;
      return { ok, clientX, clientY };
    };

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        const enterUn = await listen<DragEventPayload>(
          'o8:tauri-file-drop-enter',
          (event) => {
            if (!mounted) return;
            const pos = event.payload.position;
            if (!pos) return;
            const { ok } = hit(pos.x, pos.y);
            if (ok) setDragOver(true);
          },
        );

        const overUn = await listen<DragEventPayload>(
          'o8:tauri-file-drop-over',
          (event) => {
            if (!mounted) return;
            const pos = event.payload.position;
            if (!pos) return;
            const { ok } = hit(pos.x, pos.y);
            setDragOver(ok);
          },
        );

        const leaveUn = await listen('o8:tauri-file-drop-leave', () => {
          if (!mounted) return;
          setDragOver(false);
        });

        const dropUn = await listen<DragEventPayload>(
          'o8:tauri-file-drop',
          (event) => {
            if (!mounted) return;
            setDragOver(false);
            const pos = event.payload.position;
            if (!pos) return;
            const { ok, clientX, clientY } = hit(pos.x, pos.y);
            if (!ok) return;
            const paths = (event.payload.paths ?? []).filter(Boolean);
            if (paths.length === 0) return;
            onDropRef.current(paths, { x: clientX, y: clientY });
          },
        );

        unlistens.push(enterUn, overUn, leaveUn, dropUn);
      } catch (err) {
        console.warn('[use-tauri-file-drop] subscribe failed', err);
      }
    })();

    return () => {
      mounted = false;
      for (const u of unlistens) {
        try {
          u();
        } catch {}
      }
    };
  }, [acceptAll, disabled, hostRef]);

  return { dragOver };
}
