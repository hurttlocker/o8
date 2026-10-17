'use client';

import { useEffect, useRef, type PointerEvent } from 'react';
import { trackThreadDrag, type ThreadDragPayload } from '@/lib/workspace-terminal/thread-drag';

export function useThreadPaneDrag(thread: ThreadDragPayload) {
  const dispose = useRef<(() => void) | null>(null);
  useEffect(() => () => dispose.current?.(), []);
  return (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || (event.target as Element).closest('button,input,textarea')) return;
    event.stopPropagation(); dispose.current?.();
    dispose.current = trackThreadDrag(event, thread, { source: event.currentTarget });
  };
}
