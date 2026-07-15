'use client';

/**
 * ThreadDragGhost — the cursor-following pill shown while a chat/thread row
 * is being dragged out of the left rail (Claude Code split-screen parity).
 * Mounted once at dashboard level; renders nothing when no drag is active.
 *
 * Positioning note: pointer clientX/Y arrive in the zoomed coordinate space
 * (WKWebView reports zoom-multiplied px under CSS zoom), while a fixed
 * element inside the zoomed root is scaled AGAIN at paint. Divide by the
 * root zoom level so the pill lands under the real cursor at 80%/125%.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  THREAD_DRAG_CANCEL_EVENT,
  THREAD_DRAG_END_EVENT,
  THREAD_DRAG_MOVE_EVENT,
  THREAD_DRAG_START_EVENT,
  type ThreadDragMoveDetail,
  type ThreadDragStartDetail,
} from '@/lib/workspace-terminal/thread-drag';

function rootZoomLevel(): number {
  if (typeof document === 'undefined') return 1;
  const raw = window.getComputedStyle(document.documentElement).zoom;
  const parsed = Number.parseFloat(String(raw ?? '1'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function ThreadDragGhost() {
  const [drag, setDrag] = useState<{ title: string } | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  // Last pointer position, tracked OUTSIDE React state: the pill mounts a
  // commit after the drag starts, so the mount effect below re-applies the
  // latest position — without this the first frame flashes at (0,0).
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const position = (clientX: number, clientY: number) => {
      lastPointRef.current = { x: clientX, y: clientY };
      const pill = pillRef.current;
      if (!pill) return;
      const zoom = rootZoomLevel();
      // Offset so the pill trails just below-right of the pointer, like a
      // native drag image, without swallowing pointer events (none anyway).
      pill.style.transform = `translate(${clientX / zoom + 12}px, ${clientY / zoom + 14}px)`;
    };

    const handleStart = (event: Event) => {
      const detail = (event as CustomEvent<ThreadDragStartDetail>).detail;
      if (!detail?.payload) return;
      lastPointRef.current = { x: detail.clientX, y: detail.clientY };
      setDrag({ title: detail.payload.title });
    };
    const handleMove = (event: Event) => {
      const detail = (event as CustomEvent<ThreadDragMoveDetail>).detail;
      if (!detail) return;
      position(detail.clientX, detail.clientY);
    };
    const handleEnd = () => setDrag(null);

    window.addEventListener(THREAD_DRAG_START_EVENT, handleStart);
    window.addEventListener(THREAD_DRAG_MOVE_EVENT, handleMove);
    window.addEventListener(THREAD_DRAG_END_EVENT, handleEnd);
    window.addEventListener(THREAD_DRAG_CANCEL_EVENT, handleEnd);
    return () => {
      window.removeEventListener(THREAD_DRAG_START_EVENT, handleStart);
      window.removeEventListener(THREAD_DRAG_MOVE_EVENT, handleMove);
      window.removeEventListener(THREAD_DRAG_END_EVENT, handleEnd);
      window.removeEventListener(THREAD_DRAG_CANCEL_EVENT, handleEnd);
    };
  }, []);

  // Apply the drag-start position the moment the pill mounts (the start
  // event fires a commit before the pill exists in the DOM).
  useEffect(() => {
    if (!drag) return;
    const pill = pillRef.current;
    const point = lastPointRef.current;
    if (!pill || !point) return;
    const zoom = rootZoomLevel();
    pill.style.transform = `translate(${point.x / zoom + 12}px, ${point.y / zoom + 14}px)`;
  }, [drag]);

  if (!drag || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={pillRef}
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        // Parked offscreen until the mount effect stamps the real position.
        transform: 'translate(-9999px, -9999px)',
        zIndex: 100000,
        pointerEvents: 'none',
        maxWidth: 260,
        paddingTop: 5,
        paddingBottom: 5,
        paddingLeft: 12,
        paddingRight: 12,
        borderRadius: 8,
        background: 'var(--t-bg-card, rgba(30,30,32,0.92))',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-border)',
        boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
        color: 'var(--t-text)',
        fontSize: 12,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        opacity: 0.92,
      }}
    >
      {drag.title}
    </div>,
    document.body,
  );
}
