'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { FloatingSurface, useFloatingSurfaceMaterial } from './FloatingSurface';

/** Centered glass dialog. Focus stays inside and returns to its launcher. */
export function FloatingDialog({ title, children, onClose, glass, overlay, width = 400 }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  glass?: boolean;
  overlay?: boolean;
  width?: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const reduceMotion = useReducedMotion();
  const { isAllGlass } = useFloatingSurfaceMaterial(glass);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []).filter((node) => !node.closest('[hidden], [inert]'));
    (root.current?.querySelector<HTMLElement>('[data-dialog-initial-focus]') ?? focusable()[0] ?? root.current)?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const nodes = focusable(); const first = nodes[0]; const last = nodes.at(-1);
      if (!first) { event.preventDefault(); root.current?.focus(); return; }
      if (!root.current?.contains(document.activeElement) || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => { window.removeEventListener('keydown', keydown, true); if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true }); };
  }, []);
  if (typeof document === 'undefined') return null;
  return createPortal(<div onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 10020, display: 'grid', placeItems: 'center', padding: 16 }}>
    {/* A sibling fog lets the dialog blur the workspace rather than a filtered ancestor. */}
    <div aria-hidden="true" onPointerDown={onClose} style={{ position: 'absolute', inset: 0, background: overlay ? 'rgba(0, 0, 0, 0.05)' : 'color-mix(in srgb, var(--t-canvas-bg) 28%, transparent)', ...(overlay && !isAllGlass ? { backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' } : {}) }} />
    <motion.div initial={reduceMotion ? false : { opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }} style={{ position: 'relative', width: `min(${width}px, 100%)`, maxHeight: 'calc(100vh - 32px)' }}>
      <FloatingSurface ref={root} glass={glass} overlay={overlay} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} style={{ borderRadius: 22 }} contentStyle={{ padding: 24, maxHeight: 'calc(100vh - 32px)', boxSizing: 'border-box', overflowY: 'auto', scrollbarWidth: 'none' }}>{children}</FloatingSurface>
    </motion.div>
  </div>, document.body);
}
