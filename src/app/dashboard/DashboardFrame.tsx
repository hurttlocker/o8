'use client';

import { useCallback, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { generateClipPath, getLayoutSize, type SmoothCornerOptions } from '@lisse/core';

interface DashboardFrameProps extends HTMLAttributes<HTMLDivElement> {
  corners: SmoothCornerOptions;
  autoEffects?: false;
  children?: ReactNode;
}

/** The dashboard frames use clipping only. Consume the browser's completed
 * layout instead of forcing getComputedStyle reads between sibling commits.
 */
export function DashboardFrame({ corners, autoEffects: _autoEffects, children, ...props }: DashboardFrameProps) {
  const element = useRef<HTMLDivElement>(null);
  const latestCorners = useRef(corners);
  const lastSize = useRef<{ width: number; height: number } | null>(null);
  const cornerKey = JSON.stringify(corners);
  useLayoutEffect(() => { latestCorners.current = corners; }, [corners]);
  const apply = useCallback((width: number, height: number) => {
    if (!element.current || width <= 0 || height <= 0) return;
    element.current.style.clipPath = generateClipPath(width, height, latestCorners.current);
    element.current.setAttribute('data-state', 'ready');
  }, []);

  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    let active = true;
    const savedClipPath = node.style.clipPath;
    node.setAttribute('data-slot', 'smooth-corners');
    node.setAttribute('data-state', 'pending');
    const observer = new ResizeObserver(entries => {
      if (!active) return;
      const entry = entries.find(entry => entry.target === node);
      if (!entry) return;
      // Older WebKit exposes a single size rather than an array.
      const sizes = entry.borderBoxSize as readonly ResizeObserverSize[] | ResizeObserverSize;
      const box = Array.isArray(sizes) ? sizes[0] : sizes as ResizeObserverSize;
      // Preserve fractional CSS sizes on engines without border-box entries;
      // this fallback runs after layout, outside the React commit.
      const { width, height } = box ? { width: box.inlineSize, height: box.blockSize } : getLayoutSize(node);
      lastSize.current = { width, height };
      apply(width, height);
    });
    observer.observe(node, { box: 'border-box' });
    return () => {
      active = false;
      observer.disconnect();
      lastSize.current = null;
      node.style.clipPath = savedClipPath;
      node.removeAttribute('data-slot');
      node.removeAttribute('data-state');
    };
  }, [apply]);

  useLayoutEffect(() => {
    const size = lastSize.current;
    if (size) apply(size.width, size.height);
  }, [cornerKey, apply]);

  return <div {...props} ref={element}>{children}</div>;
}
