'use client';

/**
 * CornerResize — the unified canvas-card resize affordance (operator call,
 * 2026-06-15): the concentric squircle corner arc that photo/video cards always
 * had, promoted to EVERY modal — but it reveals only at the ONE corner the
 * cursor is over (the dock-proximity principle: show the affordance you're about
 * to grab, never all four at once), and it disappears entirely in grid mode
 * (the grid owns sizing, so manual resize is moot there).
 *
 * Rollout is opt-in, one card kind at a time: GlassCardShell renders this only
 * when `cornerHandles` is set, so we flip kinds on as we like the look. Replaces
 * the old invisible 8-zone hidden handles.
 */

import { useRef, useState } from 'react';
import { canvasZoom, RESIZE_ARC } from './ui';

type Corner = 'nw' | 'ne' | 'se' | 'sw';
type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
interface Geom { x: number; y: number; w: number; h: number; }

/** Corner anchors. The arc bulges toward bottom-right at rotate 0, so each
 *  corner rotates it 90° clockwise to hug its own corner: se 0 → sw 90 → nw 180
 *  → ne 270. */
const CORNERS: Array<{ key: Corner; left: string | number; top: string | number; rotate: number; cursor: string }> = [
  { key: 'se', left: '100%', top: '100%', rotate: 0, cursor: 'nwse-resize' },
  { key: 'sw', left: 0, top: '100%', rotate: 90, cursor: 'nesw-resize' },
  { key: 'nw', left: 0, top: 0, rotate: 180, cursor: 'nwse-resize' },
  { key: 'ne', left: '100%', top: 0, rotate: 270, cursor: 'nesw-resize' },
];

/** Thin invisible edge strips for 2-axis resize (kept for shell/chat power use;
 *  off for aspect-locked media). Inset from the corners so they never fight the
 *  corner zones. */
const EDGES: Array<{ key: Edge; cursor: string; style: React.CSSProperties }> = [
  { key: 'n', cursor: 'ns-resize', style: { top: -5, left: 20, right: 20, height: 10 } },
  { key: 's', cursor: 'ns-resize', style: { bottom: -5, left: 20, right: 20, height: 10 } },
  { key: 'e', cursor: 'ew-resize', style: { top: 20, bottom: 20, right: -5, width: 10 } },
  { key: 'w', cursor: 'ew-resize', style: { top: 20, bottom: 20, left: -5, width: 10 } },
];

/** Corner hover/hit target, centered on the corner. */
const ZONE = 30;

/** New geometry for a resize drag. card.h is the BODY height (chrome sits on
 *  top), so a top/left grab repositions x/y while the opposite edge stays put.
 *  `aspect` (w/h) locks the ratio — width leads, height follows, opposite
 *  edge/corner pinned. */
function resizeGeom(edge: Edge, dx: number, dy: number, start: Geom, minW: number, minH: number, aspect?: number): Geom {
  let { x, y, w, h } = start;
  if (edge.includes('e')) w = start.w + dx;
  if (edge.includes('w')) { w = start.w - dx; x = start.x + dx; }
  if (edge.includes('s')) h = start.h + dy;
  if (edge.includes('n')) { h = start.h - dy; y = start.y + dy; }
  if (w < minW) { if (edge.includes('w')) x -= minW - w; w = minW; }
  if (h < minH) { if (edge.includes('n')) y -= minH - h; h = minH; }
  if (aspect && aspect > 0) {
    h = w / aspect;
    if (h < minH) { h = minH; w = h * aspect; }
    if (edge.includes('n')) y = start.y + start.h - h;
    if (edge.includes('w')) x = start.x + start.w - w;
  }
  return { x, y, w, h };
}

export function CornerResize({
  card,
  minW,
  minH,
  onMove,
  onResize,
  onResizingChange,
  aspect,
  edges = true,
}: {
  card: { id: number; x: number; y: number; w: number; h: number };
  minW: number;
  minH: number;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  /** Lets the parent suppress backdrop blur while resizing (drag flicker fix). */
  onResizingChange?: (resizing: boolean) => void;
  /** When set, resize is ratio-locked to this w/h (photo & video cards). */
  aspect?: number;
  /** Invisible edge strips for 2-axis resize (shell/chat). Off for media. */
  edges?: boolean;
}) {
  const [active, setActive] = useState<Corner | null>(null);
  const ref = useRef<{ pointerId: number; edge: Edge; startX: number; startY: number; start: Geom } | null>(null);

  const down = (edge: Edge) => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic/stale pointer */ }
    ref.current = { pointerId: event.pointerId, edge, startX: event.clientX, startY: event.clientY, start: { x: card.x, y: card.y, w: card.w, h: card.h } };
    onResizingChange?.(true);
  };
  const move = (event: React.PointerEvent) => {
    const r = ref.current;
    if (!r || r.pointerId !== event.pointerId) return;
    const zoom = canvasZoom();
    const next = resizeGeom(r.edge, (event.clientX - r.startX) / zoom, (event.clientY - r.startY) / zoom, r.start, minW, minH, aspect);
    onResize(card.id, next.w, next.h);
    if (next.x !== r.start.x || next.y !== r.start.y) onMove(card.id, next.x, next.y);
  };
  const up = (event: React.PointerEvent) => {
    if (ref.current?.pointerId !== event.pointerId) return;
    ref.current = null;
    onResizingChange?.(false);
    setActive(null);
  };

  return (
    <>
      {edges ? EDGES.map((e) => (
        <div
          key={e.key}
          role="presentation"
          onPointerDown={down(e.key)}
          onPointerMove={move}
          onPointerUp={up}
          style={{ position: 'absolute', cursor: e.cursor, touchAction: 'none', zIndex: 5, ...e.style }}
        />
      )) : null}
      {CORNERS.map((c) => (
        <div
          key={c.key}
          role="presentation"
          onMouseEnter={() => setActive(c.key)}
          onMouseLeave={() => { if (!ref.current) setActive(null); }}
          onPointerDown={down(c.key)}
          onPointerMove={move}
          onPointerUp={up}
          style={{
            position: 'absolute',
            left: c.left,
            top: c.top,
            width: ZONE,
            height: ZONE,
            transform: 'translate(-50%, -50%)',
            cursor: c.cursor,
            touchAction: 'none',
            zIndex: 6,
          }}
        >
          <svg
            width={RESIZE_ARC.size}
            height={RESIZE_ARC.size}
            viewBox={`0 0 ${RESIZE_ARC.size} ${RESIZE_ARC.size}`}
            fill="none"
            aria-hidden
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: `translate(-50%, -50%) rotate(${c.rotate}deg)`,
              overflow: 'visible',
              // Proximity reveal × grid gate: only the hovered corner shows its
              // arc, and --cnv-grid=1 multiplies that to 0 (no handles in grid).
              opacity: `calc(${active === c.key ? 1 : 0} * (1 - var(--cnv-grid, 0)))`,
              transition: 'opacity 140ms ease',
              pointerEvents: 'none',
            } as React.CSSProperties}
          >
            <path d={RESIZE_ARC.d} stroke="var(--cnv-media-rim)" strokeWidth={7} strokeLinecap="round" />
          </svg>
        </div>
      ))}
    </>
  );
}
