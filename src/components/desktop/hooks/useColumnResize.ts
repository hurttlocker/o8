'use client';

import { useCallback, useEffect, useRef, type PointerEvent } from 'react';
import { readAppliedUiZoom } from '@/lib/appearance/ui-zoom';
import { trackPointerGesture } from '@/lib/ui/pointer-gesture';

export const COLUMN_HANDLE_WIDTH = 4;
export const RIGHT_COLUMN_CHROME = COLUMN_HANDLE_WIDTH + 4;
export const WORKSPACE_RESERVE = 420;

/** Frame-rate layout updates while dragging; commit the preference on release only. */
export function useColumnResize(setDragging: (value: boolean) => void) {
  const dispose = useRef<(() => void) | null>(null);
  useEffect(() => () => dispose.current?.(), []);
  return useCallback((event: PointerEvent<HTMLDivElement>, options: {
    side: 'left' | 'right'; min: number; max: number; commit: (width: number) => void;
  }) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); dispose.current?.();
    const source = event.currentTarget;
    const column = options.side === 'left' ? source.previousElementSibling as HTMLElement | null
      : source.parentElement?.querySelector<HTMLElement>('[data-mcp-scope="chat-panel"]') ?? null;
    if (!column) return;
    const shell = options.side === 'right' ? column.parentElement : null;
    const footer = options.side === 'left' ? column.querySelector<HTMLElement>('[data-o8-left-footer]') : null;
    const before = { column: column.style.width, shell: shell?.style.width, footer: footer?.style.width };
    const zoom = readAppliedUiZoom();
    const startWidth = column.getBoundingClientRect().width / zoom;
    const available = options.side === 'right' ? shell?.parentElement?.getBoundingClientRect().width ?? 0 : 0;
    const maximum = options.side === 'right' && available > 0
      ? Math.min(options.max, Math.max(0, available / zoom - WORKSPACE_RESERVE - RIGHT_COLUMN_CHROME)) : options.max;
    const minimum = Math.min(options.min, maximum);
    const widthAt = (x: number) => Math.max(minimum, Math.min(maximum,
      startWidth + (x - event.clientX) / zoom * (options.side === 'left' ? 1 : -1)));
    let frame = 0;
    let width = startWidth;
    const paint = (value: number) => {
      column.style.width = `${value}px`;
      if (shell) shell.style.width = `${value + RIGHT_COLUMN_CHROME}px`;
      if (footer) footer.style.width = `${value}px`;
    };
    const finish = (value: number, commit: boolean) => {
      if (frame) window.cancelAnimationFrame(frame);
      if (commit) { paint(value); options.commit(value); }
      else {
        column.style.width = before.column;
        if (shell) shell.style.width = before.shell ?? '';
        if (footer) footer.style.width = before.footer ?? '';
      }
      // Keep layout transitions off through the preference's React commit.
      window.requestAnimationFrame(() => setDragging(false));
      dispose.current = null;
    };
    dispose.current = trackPointerGesture(source, event, {
      threshold: 0, cursor: 'col-resize', onStart: () => setDragging(true),
      onMove: point => {
        width = widthAt(point.clientX);
        if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; paint(width); });
      },
      onEnd: point => finish(widthAt(point.clientX), true),
      onCancel: () => finish(startWidth, false),
    });
  }, [setDragging]);
}
