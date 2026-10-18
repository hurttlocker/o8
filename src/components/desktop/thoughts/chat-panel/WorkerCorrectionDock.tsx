'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FloatingSurface } from '@/components/desktop/FloatingSurface';
import { useWorkerDisclosure } from './WorkerDisclosure';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

/** A disclosure on the composer edge. Opening it never changes the input's geometry. */
export function WorkerCorrectionDock({ label, summary, attention, active = true, onOpen, children }: {
  label: string; summary: string; attention: boolean; active?: boolean;
  onOpen: () => void; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const hovered = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const reducedMotion = useReducedMotion();
  const disclosure = useWorkerDisclosure();
  const [layout, setLayout] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const expanded = active && open && (!disclosure || disclosure.activeId === id);
  const reveal = () => { if (!expanded) { onOpen(); setPinned(false); } setOpen(true); disclosure?.activate(id); };
  const close = () => { setOpen(false); setPinned(false); disclosure?.deactivate(id); };
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !panel.current?.contains(event.target)) { setOpen(false); setPinned(false); disclosure?.deactivate(id); }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [expanded, disclosure, id]);
  useEffect(() => {
    if (!expanded || !root.current) return;
    const anchor = root.current;
    const measure = () => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(440, rect.width, window.innerWidth - 24);
      const next = { left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), bottom: window.innerHeight - rect.top, width };
      setLayout(previous => previous && previous.left === next.left && previous.bottom === next.bottom && previous.width === next.width ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(anchor);
    window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [expanded]);
  const duration = reducedMotion || keyboard ? 0 : 0.18;
  return <div ref={root} data-worker-correction-dock="" style={{ position: 'absolute', top: -13, left: 14, right: 14, maxWidth: 440, height: 26, pointerEvents: 'none', zIndex: expanded ? 6 : 4 }}
    onMouseEnter={() => { hovered.current = true; if (active) reveal(); }}
    onMouseLeave={() => { hovered.current = false; if (!pinned && !root.current?.contains(document.activeElement) && !panel.current?.contains(document.activeElement)) setOpen(false); }}
    onFocusCapture={event => { setKeyboard(event.target.matches(':focus-visible')); reveal(); }}
    onBlurCapture={event => { if (!pinned && !hovered.current && !root.current?.contains(event.relatedTarget as Node | null) && !panel.current?.contains(event.relatedTarget as Node | null)) setOpen(false); }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); trigger.current?.focus(); close(); }
      if (event.key === 'Tab' && expanded) {
        const first = panel.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)');
        if (!event.shiftKey && event.target === trigger.current && first) { event.preventDefault(); first.focus(); }
        else if (event.shiftKey && event.target === first) { event.preventDefault(); trigger.current?.focus(); }
      }
    }}>
    <button ref={trigger} type="button" aria-label={`${label}: ${summary}`} aria-expanded={expanded} aria-controls={id}
      onPointerDown={() => setKeyboard(false)} onClick={() => { if (pinned && expanded) close(); else { reveal(); setPinned(true); } }}
      style={{ height: 26, width: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, borderRadius: 8, pointerEvents: 'auto',
        fontFamily: 'var(--font-sans-system)', fontSize: 11, fontWeight: 300, cursor: 'pointer',
        background: expanded ? 'var(--t-panel-hover)' : 'transparent', color: attention ? 'var(--t-accent)' : expanded ? 'var(--t-text-muted)' : 'var(--t-text-faint)' }}>
      <svg aria-hidden width="26" height="16" viewBox="0 0 26 16" fill="none" style={{ flexShrink: 0 }}>
        <motion.path initial={false} animate={{ d: expanded ? 'M3 3H15 M3 8H23 M3 13H19' : 'M3 8H8 M11 8H16 M19 8H23' }}
          transition={{ duration, ease: [0.22, 1, 0.36, 1] }} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
    {/* Escape the workspace corner clip so WebKit can frost transcript content, like Brain. */}
    {layout ? createPortal(<AnimatePresence initial={false}>
      {expanded ? <motion.div ref={panel} key="controls" id={id} role="region" aria-label="Worker controls"
        initial={{ y: 4 }} animate={{ y: 0 }} exit={{ y: 4 }}
        transition={{ duration, ease: [0.22, 1, 0.36, 1] }}
        onPointerDown={() => setPinned(true)}
        style={{ position: 'fixed', ...layout, zIndex: 190, paddingBottom: 6, pointerEvents: 'auto' }}>
        <FloatingSurface overlay style={{ borderRadius: 14 }} contentStyle={{
          padding: 12, maxHeight: 'min(480px, 55vh)', overflowY: 'auto', scrollbarWidth: 'none', overscrollBehavior: 'contain',
          display: 'flex', flexDirection: 'column', gap: 10, fontFamily: 'var(--font-sans-system)', fontSize: 11, fontWeight: 300, color: 'var(--t-text-muted)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ color: 'var(--t-text)', fontSize: 12 }}>Workers</span>
            <button type="button" aria-label="Close worker controls" onClick={() => { trigger.current?.focus(); close(); }}
              style={{ border: 0, borderRadius: 7, width: 26, height: 26, cursor: 'pointer', background: 'transparent', color: 'var(--t-text-muted)' }}>
              <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
            </button>
          </div>
          {children}
        </FloatingSurface>
      </motion.div> : null}
    </AnimatePresence>, document.body) : null}
  </div>;
}
