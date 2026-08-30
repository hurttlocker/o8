'use client';

/**
 * Input Anticipation (operator design-eng tip, 2026-06-13) — a focus ring
 * that fades IN as the cursor approaches the input, so the field reads as
 * "ready for you" before you ever click. Reacting to intent, not just the
 * act, makes the surface feel faster.
 *
 * Idiomatic, not the raw top-level `addEventListener` snippet:
 *  - the window pointermove is effect-managed (added on mount, removed on
 *    unmount) and rAF-batched — one write per frame, not per event;
 *  - it only writes `opacity` (composite-only — never triggers layout, so
 *    no thrash even though it reads the rect each frame);
 *  - on REAL focus the ring locks fully on; on blur it eases back to the
 *    distance-based value from the last cursor (no flash);
 *  - gated to fine-pointer devices and disabled under reduced-motion (the
 *    ring still appears on focus, just no anticipation).
 *
 * Renders an overlay sized to its positioned parent (the composer pill) and
 * reads its OWN rect for the distance, so it tracks the pill as it grows.
 */

import { useCallback, useEffect, useRef } from 'react';

const REACH = 180; // px — how far out the field starts anticipating

export function AnticipationRing({ focused, radius = 24 }: { focused: boolean; radius?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const focusedRef = useRef(focused);
  const enabledRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef(0);

  // Single source of truth for the ring's opacity (reads only refs → stable).
  const apply = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (focusedRef.current) { el.style.opacity = '1'; return; }
    if (!enabledRef.current || !lastRef.current) { el.style.opacity = '0'; return; }
    const r = el.getBoundingClientRect();
    const { x, y } = lastRef.current;
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const intent = Math.max(0, 1 - Math.hypot(dx, dy) / REACH) ** 2;
    el.style.opacity = intent.toFixed(3);
  }, []);

  useEffect(() => {
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => { enabledRef.current = fine.matches && !reduced.matches; apply(); };
    sync();
    fine.addEventListener('change', sync);
    reduced.addEventListener('change', sync);
    const onMove = (event: PointerEvent) => {
      lastRef.current = { x: event.clientX, y: event.clientY };
      if (!enabledRef.current || focusedRef.current) return;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(apply);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      fine.removeEventListener('change', sync);
      reduced.removeEventListener('change', sync);
      cancelAnimationFrame(rafRef.current);
    };
  }, [apply]);

  // Focus/blur re-applies at once (blur uses the last cursor, so it eases
  // to the right anticipation level instead of snapping off).
  useEffect(() => {
    focusedRef.current = focused;
    apply();
  }, [focused, apply]);

  return (
    <div
      ref={ref}
      aria-hidden
      style={{
        position: 'absolute',
        inset: -1.5,
        borderRadius: radius + 1.5,
        pointerEvents: 'none',
        opacity: 0,
        transition: 'opacity 200ms ease-out',
        // A brighter take on the glass hairline — the field's edge lights up.
        boxShadow: '0 0 0 1.5px var(--cnv-ink), 0 0 20px 1px var(--cnv-ink)',
      }}
    />
  );
}
