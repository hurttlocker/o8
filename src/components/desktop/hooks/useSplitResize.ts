'use client';

import { useCallback, useEffect, useRef, type PointerEvent, type RefObject } from 'react';
import { readAppliedUiZoom } from '@/lib/appearance/ui-zoom';
import { trackPointerGesture } from '@/lib/ui/pointer-gesture';

type Rect = { left: number; top: number; width: number; height: number };
/** Keep the grabbed offset, track one pointer, and restore the split on cancellation. */
export function useSplitResize(surface: RefObject<HTMLDivElement | null>, resize: (id: string, ratio: number) => void) {
  const dispose = useRef<(() => void) | null>(null);
  useEffect(() => () => dispose.current?.(), []);
  return useCallback((id: string, direction: 'vertical' | 'horizontal', container: Rect, ratio: number) =>
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !event.isPrimary) return;
      const rect = surface.current?.getBoundingClientRect();
      if (!rect) return;
      event.preventDefault(); dispose.current?.();
      const vertical = direction === 'vertical';
      const size = vertical ? rect.width * container.width : rect.height * container.height;
      if (size <= 0) return;
      const origin = vertical ? event.clientX : event.clientY;
      const minimum = Math.min(0.5, Math.max(0.2, (vertical ? 240 : 120) * readAppliedUiZoom() / size));
      const at = (point: { clientX: number; clientY: number }) => Math.max(minimum, Math.min(1 - minimum,
        ratio + ((vertical ? point.clientX : point.clientY) - origin) / size));
      let frame = 0; let next = ratio;
      const finish = (value: number) => {
        if (frame) cancelAnimationFrame(frame);
        resize(id, value); dispose.current = null;
      };
      dispose.current = trackPointerGesture(event.currentTarget, event, {
        threshold: 0, cursor: vertical ? 'col-resize' : 'row-resize',
        onMove: point => {
          next = at(point);
          if (!frame) frame = requestAnimationFrame(() => { frame = 0; resize(id, next); });
        },
        onEnd: point => finish(at(point)), onCancel: () => finish(ratio),
      });
    }, [surface, resize]);
}
