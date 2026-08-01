'use client';

/**
 * Scroll-blur fade (operator call, 2026-06-13). Heavy
 * backdrop blur during fast scroll wrecks perceived smoothness and spikes GPU
 * cost. While a glass surface's scroll container is moving, scale its blur DOWN
 * via the `--cnv-frost-scale` var on its nearest `[data-glass-surface]`
 * ancestor (the card outer / dock shell); restore full frost ~140ms after the
 * last scroll. Crisp in motion, full glass at rest.
 *
 * Reusable on ANY canvas scroll container: give the surface
 * `data-glass-surface` (card-shell, dock, chat-card already do) and call
 * `useScrollBlurFade(scrollRef)` on the scrolling element.
 */

import { useEffect, type RefObject } from 'react';

const ACTIVE_SCALE = 0.4; // blur multiplier while scrolling (tweet: 24px → 8px)
const SETTLE_MS = 140;     // restore this long after the last scroll tick

export function useScrollBlurFade(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Reduced-motion users keep a steady blur — no dynamic flicker.
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    let surface: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onScroll = () => {
      if (!surface) surface = el.closest('[data-glass-surface]') as HTMLElement | null;
      if (!surface) return;
      surface.style.setProperty('--cnv-frost-scale', String(ACTIVE_SCALE));
      clearTimeout(timer);
      timer = setTimeout(() => {
        surface?.style.setProperty('--cnv-frost-scale', '1');
      }, SETTLE_MS);
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      clearTimeout(timer);
      surface?.style.removeProperty('--cnv-frost-scale');
    };
  }, [ref]);
}
