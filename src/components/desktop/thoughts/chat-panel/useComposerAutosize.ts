'use client';

import { useLayoutEffect, type RefObject } from 'react';

/** Typed, inserted and restored drafts share the same bounded reading area. */
export function useComposerAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string, active: boolean) {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !active) return;
    const resize = () => {
      if (!node.isConnected || !node.getBoundingClientRect().width) return;
      const limit = Math.max(52, Math.min(200, window.innerHeight * 0.28));
      node.style.height = 'auto';
      node.style.height = `${Math.max(52, Math.min(node.scrollHeight, limit))}px`;
    };
    resize();
    let width = node.getBoundingClientRect().width;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      const next = node.getBoundingClientRect().width;
      if (next === width) return;
      width = next;
      resize();
    });
    observer?.observe(node);
    window.addEventListener('resize', resize);
    return () => { observer?.disconnect(); window.removeEventListener('resize', resize); };
  }, [active, ref, value]);
}
