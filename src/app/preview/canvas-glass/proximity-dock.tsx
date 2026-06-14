'use client';

/**
 * Proximity magnification — the macOS-dock feel (operator design-eng tip,
 * 2026-06-13): items near the cursor scale up and darken by DISTANCE, the
 * rest sit at rest. Proximity, not binary hover, so a row/column of glyphs
 * reads as one living surface that leans toward you.
 *
 * Framework-idiomatic per the "raw el.style snippet will bite you" rule, and
 * tuned for SMOOTH (no chop):
 *  - the pointer handler is scoped to THIS container, never a global
 *    `window.onpointermove` (which clobbers other handlers);
 *  - rest centers are measured ONCE per hover (on enter), so the rAF loop
 *    never calls getBoundingClientRect per frame — no read-after-write
 *    layout thrash, the usual source of the jank;
 *  - a single rAF loop LERPS each item's scale toward its target every
 *    frame (continuous easing, framerate-locked) instead of restarting a
 *    CSS transition against a moving target — that's what felt choppy;
 *  - the transform lives on a wrapper <span> we own, so it never fights a
 *    child button's own hover background/color writes;
 *  - it eases back to rest on pointer-leave, then the loop parks itself;
 *  - gated to fine-pointer devices and disabled under reduced-motion.
 *
 * `axis` is the magnification axis: 'y' for a vertical rail (distance on
 * clientY), 'x' for a horizontal dock (clientX).
 */

import { Children, useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

const RANGE = 84;     // px falloff along the axis — past this, an item is at rest
const MAG = 0.07;     // peak scale bump on the item under the cursor (a whisper of a lift)
const DARKEN = 0.07;  // peak black-wash alpha — the "darken" that tracks proximity
const LERP = 0.22;    // per-frame approach to target — lower = smoother/softer

export function ProximityDock({
  children,
  axis = 'y',
  itemRadius = 11,
  style,
}: {
  children: ReactNode;
  axis?: 'x' | 'y';
  itemRadius?: number;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const centersRef = useRef<number[]>([]);
  const scalesRef = useRef<number[]>([]);
  const cursorRef = useRef<number | null>(null);
  const rafRef = useRef(0);
  const onRef = useRef(false);

  useEffect(() => {
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => { onRef.current = fine.matches && !reduced.matches; };
    sync();
    fine.addEventListener('change', sync);
    reduced.addEventListener('change', sync);
    return () => {
      fine.removeEventListener('change', sync);
      reduced.removeEventListener('change', sync);
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Measure rest centers once per hover — transforms don't move siblings
  // (scale is visual only), so these stay valid for the whole hover.
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const kids = Array.from(el.children) as HTMLElement[];
    centersRef.current = kids.map((kid) => {
      const r = kid.getBoundingClientRect();
      return axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2;
    });
    if (scalesRef.current.length !== kids.length) scalesRef.current = kids.map(() => 1);
  };

  const tick = () => {
    const el = ref.current;
    if (!el) { rafRef.current = 0; return; }
    const kids = Array.from(el.children) as HTMLElement[];
    const cursor = cursorRef.current;
    let moving = false;
    kids.forEach((span, i) => {
      let target = 1;
      if (cursor !== null && centersRef.current[i] !== undefined) {
        const t = Math.max(0, 1 - Math.abs(cursor - centersRef.current[i]) / RANGE);
        const e = t * t * (3 - 2 * t); // smoothstep — a rounder bulge than linear
        target = 1 + e * MAG;
      }
      const cur = scalesRef.current[i] ?? 1;
      let next = cur + (target - cur) * LERP;
      if (Math.abs(target - next) < 0.0008) next = target;
      else moving = true;
      scalesRef.current[i] = next;
      const prox = MAG > 0 ? (next - 1) / MAG : 0;
      span.style.transform = `scale(${next.toFixed(4)})`;
      span.style.backgroundColor = prox > 0.01 ? `rgba(0,0,0,${(prox * DARKEN).toFixed(3)})` : 'transparent';
      span.style.zIndex = prox > 0.01 ? '1' : '0';
    });
    rafRef.current = moving ? requestAnimationFrame(tick) : 0;
  };

  const ensureLoop = () => { if (!rafRef.current) rafRef.current = requestAnimationFrame(tick); };

  const onEnter = () => { if (onRef.current) measure(); };
  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onRef.current) return;
    cursorRef.current = axis === 'x' ? event.clientX : event.clientY;
    ensureLoop();
  };
  const onLeave = () => { cursorRef.current = null; ensureLoop(); };

  return (
    <div ref={ref} onPointerEnter={onEnter} onPointerMove={onMove} onPointerLeave={onLeave} style={style}>
      {Children.map(children, (child) => (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: itemRadius,
            transformOrigin: 'center',
            willChange: 'transform',
          }}
        >
          {child}
        </span>
      ))}
    </div>
  );
}
