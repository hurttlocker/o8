'use client';

import { type Dispatch, type MouseEventHandler, type SetStateAction } from 'react';
import { ResizeEdge } from './ResizeEdge';

/** Glow the straight edge without repainting or changing the panel's corners. */
export function ChatListResizeEdge({ width, glass, onStartDrag, setWidth }: {
  width: number;
  glass: boolean;
  onStartDrag: MouseEventHandler<HTMLDivElement>;
  setWidth: Dispatch<SetStateAction<number>>;
}) {
  return (
    <ResizeEdge aria-label="Chat list width"
      aria-valuemin={160} aria-valuemax={500} aria-valuenow={width}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? 16 : -16;
        setWidth((current) => Math.max(160, Math.min(500, current + delta)));
      }}
      onMouseDown={onStartDrag}
      style={{ width: 6 }}
      // Glass puts its 34px header above the curved card. Solid encloses it.
      glowStyle={{ top: glass ? 53 : 18, bottom: glass ? 0 : 18, left: -6, transform: 'none' }}
    />
  );
}
