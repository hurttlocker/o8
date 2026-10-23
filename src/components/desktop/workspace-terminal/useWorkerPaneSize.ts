'use client';

import { useEffect, useRef, useState } from 'react';
import { isCompactWorkerPane } from './worker-pane-chrome';

export function useWorkerPaneSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(true);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = (width: number, height: number) => setCompact(isCompactWorkerPane(width, height));
    const bounds = node.getBoundingClientRect();
    measure(bounds.width, bounds.height);
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (rect) measure(rect.width, rect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { paneRef: ref, compact };
}
