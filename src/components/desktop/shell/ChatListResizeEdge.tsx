'use client';

import { useRef, type Dispatch, type PointerEventHandler, type SetStateAction } from 'react';
import { readAppliedUiZoom } from '@/lib/appearance/ui-zoom';
import { ResizeEdge } from './ResizeEdge';
import { COLUMN_HANDLE_WIDTH } from '../hooks/useColumnResize';

/** Glow the straight edge without repainting or changing the panel's corners. */
export function ChatListResizeEdge({ width, glass, joined = false, onStartDrag, setWidth }: {
  width: number;
  glass: boolean;
  joined?: boolean;
  onStartDrag: PointerEventHandler<HTMLDivElement>;
  setWidth: Dispatch<SetStateAction<number>>;
}) {
  const host = useRef<HTMLDivElement>(null);
  return (
    <ResizeEdge ref={host} aria-label="Chat list width"
      aria-valuemin={160} aria-valuemax={500} aria-valuenow={width}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? 16 : -16;
        const measured = host.current?.previousElementSibling?.getBoundingClientRect().width;
        setWidth(Math.max(160, Math.min(500, (measured ? measured / readAppliedUiZoom() : width) + delta)));
      }}
      onPointerDown={onStartDrag}
      style={{ width: joined ? 1 : COLUMN_HANDLE_WIDTH }}
      linePosition={joined ? 0.5 : -0.5}
      hitSlop={8}
      // Joined panels expose a straight seam from the shared header to the bottom.
      glowStyle={joined ? { top: 'var(--o8-shell-header-height, 40px)', bottom: 0 } : { top: `calc(var(--o8-shell-header-height, ${glass ? 35 : 0}px) + 18px)`, bottom: glass ? 0 : 18 }}
    />
  );
}
