'use client';

import { useEffect, useRef } from 'react';
import { remotePreviewClose, remotePreviewOpen, remotePreviewSetRect } from '@/lib/tauri/remote-preview';
import type { BrowserViewRect } from '@/lib/tauri/bridge';

/** An isolated native surface with no injected agent or shared Browser state. */
export function NativeRemotePreview({ id, url, onError }: { id: string; url: string; onError: (message: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const error = useRef(onError);
  useEffect(() => { error.current = onError; }, [onError]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let active = true;
    let opened = false;
    let last = '';
    let busy = false;
    const measure = (): { rect: BrowserViewRect; visible: boolean } => {
      const bounds = element.getBoundingClientRect();
      const zoom = window.innerWidth / (document.documentElement.getBoundingClientRect().width || window.innerWidth);
      const left = Math.max(0, bounds.left * zoom); const top = Math.max(0, bounds.top * zoom);
      const right = Math.min(window.innerWidth, bounds.right * zoom); const bottom = Math.min(window.innerHeight, bounds.bottom * zoom);
      const points = [[bounds.left + 2, bounds.top + 2], [bounds.right - 2, bounds.top + 2], [bounds.left + bounds.width / 2, bounds.top + bounds.height / 2], [bounds.right - 2, bounds.bottom - 2]];
      const uncovered = points.every(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit === element || (hit !== null && element.contains(hit));
      });
      return { rect: { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) }, visible: document.visibilityState === 'visible' && bounds.width > 1 && bounds.height > 1 && right > left && bottom > top && uncovered };
    };
    const sync = async () => {
      if (!active || busy) return;
      const { rect, visible } = measure();
      const key = JSON.stringify([rect, visible]);
      if (key === last || (!opened && !visible)) return;
      busy = true;
      try {
        if (!opened) { await remotePreviewOpen(id, url, rect); opened = true; }
        else await remotePreviewSetRect(id, rect, visible);
        last = key;
      } catch { if (active) error.current('The native preview could not open. Reconnect to try again.'); }
      finally { busy = false; if (!active) void remotePreviewClose(id).catch(() => {}); }
    };
    const tick = () => { void sync(); };
    const observer = new ResizeObserver(tick);
    observer.observe(element);
    window.addEventListener('resize', tick);
    window.addEventListener('scroll', tick, true);
    // Also tracks overlay occlusion and a workspace hidden without unmounting.
    const timer = window.setInterval(tick, 200);
    // Strict Mode replays effects before this microtask. A one-use bootstrap
    // must not open a window that the replay cleanup immediately destroys.
    queueMicrotask(tick);
    return () => {
      active = false; observer.disconnect(); window.clearInterval(timer);
      window.removeEventListener('resize', tick); window.removeEventListener('scroll', tick, true);
      if (opened) void remotePreviewClose(id).catch(() => {});
    };
  }, [id, url]);
  return <div ref={ref} aria-label="Remote task preview" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }} />;
}
