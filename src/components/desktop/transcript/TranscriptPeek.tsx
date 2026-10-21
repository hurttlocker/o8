'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FloatingSurface } from '../FloatingSurface';

/** Passive preview: keyboard focus gets the same content without moving focus. */
export function TranscriptPeek({ children, preview, width = 460, placement = 'above' }: {
  children: ReactNode; preview: () => ReactNode; width?: number; placement?: 'above' | 'right';
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const clear = () => { if (timer.current) clearTimeout(timer.current); };
  const close = () => { clear(); setPosition(null); };
  const open = () => {
    clear();
    timer.current = setTimeout(() => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const zoom = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
      const w = Math.min(width, window.innerWidth / zoom - 24);
      const above = rect.top / zoom - 12;
      const below = (window.innerHeight - rect.bottom) / zoom - 12;
      const height = Math.min(380, Math.max(above, below));
      setPosition({ left: Math.max(12, Math.min(rect.left / zoom, window.innerWidth / zoom - w - 12)),
        top: above > below ? Math.max(12, rect.top / zoom - height - 6) : rect.bottom / zoom + 6,
        width: w, maxHeight: Math.max(80, height) });
    }, 220);
  };
  useLayoutEffect(() => {
    if (!position || !anchor.current || !panel.current) return;
    const measure = () => {
      if (!anchor.current || !panel.current) return;
      const zoom = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
      const rect = anchor.current.getBoundingClientRect();
      const height = panel.current.getBoundingClientRect().height / zoom;
      const above = rect.top / zoom;
      const below = (window.innerHeight - rect.bottom) / zoom;
      const top = Math.max(12, Math.min(placement === 'right' ? above - height / 2
        : above > below ? above - height - 6 : rect.bottom / zoom + 6, window.innerHeight / zoom - height - 12));
      const left = placement === 'right' ? Math.min(rect.right / zoom + 10, window.innerWidth / zoom - position.width - 12) : position.left;
      setPosition(previous => previous && (Math.abs(previous.top - top) > 1 || Math.abs(previous.left - left) > 1) ? { ...previous, top, left } : previous);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel.current);
    return () => observer.disconnect();
  }, [position, placement]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!position) return;
    const dismiss = () => { if (timer.current) clearTimeout(timer.current); setPosition(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    const scroll = (event: Event) => { if (!(event.target instanceof Element) || !event.target.closest('[data-transcript-peek]')) dismiss(); };
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', dismiss);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', dismiss); };
  }, [position]);
  return <div ref={anchor} onMouseEnter={open} onMouseLeave={() => { clear(); timer.current = setTimeout(close, 180); }}
    onFocus={open} onBlur={close} onClick={close} style={{ minWidth: 0, flexShrink: 0 }}>
    {children}
    {position ? createPortal(<FloatingSurface ref={panel} overlay data-transcript-peek role="region" aria-label="Preview"
      onMouseEnter={clear} onMouseLeave={close}
      style={{ position: 'fixed', zIndex: 1000, left: position.left, top: position.top, width: position.width, borderRadius: 14 }}
      contentStyle={{ padding: 12, maxHeight: position.maxHeight, overflow: 'auto' }}>
      {preview()}
    </FloatingSurface>, document.body) : null}
  </div>;
}
