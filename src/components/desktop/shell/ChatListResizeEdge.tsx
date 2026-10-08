'use client';

import { useState, type Dispatch, type MouseEventHandler, type SetStateAction } from 'react';

/** Glow the straight edge without repainting or changing the panel's corners. */
export function ChatListResizeEdge({ width, glass, onStartDrag, setWidth }: {
  width: number;
  glass: boolean;
  onStartDrag: MouseEventHandler<HTMLDivElement>;
  setWidth: Dispatch<SetStateAction<number>>;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <div role="separator" tabIndex={0} aria-label="Chat list width" aria-orientation="vertical"
      aria-valuemin={160} aria-valuemax={500} aria-valuenow={width}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? 16 : -16;
        setWidth((current) => Math.max(160, Math.min(500, current + delta)));
      }}
      onMouseDown={onStartDrag} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={{ width: 6, flexShrink: 0, cursor: 'col-resize', position: 'relative', zIndex: 10, outline: 'none' }}>
      <span aria-hidden data-o8-chat-resize-edge="true" style={{
        position: 'absolute', left: -7, right: 0,
        // Glass puts its 34px header above the curved card. Solid encloses it.
        top: glass ? 53 : 18, bottom: glass ? 0 : 18,
      }}>
        <span style={{ position: 'absolute', top: 0, bottom: 0, left: 1, width: 1,
          background: 'var(--t-accent)', boxShadow: '0 0 8px var(--t-accent)',
          opacity: hovered || focused ? 0.85 : 0, transition: 'opacity 150ms ease', pointerEvents: 'none' }} />
      </span>
    </div>
  );
}
