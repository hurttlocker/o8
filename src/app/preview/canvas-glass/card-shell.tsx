'use client';

/**
 * GlassCardShell — the one canvas-modal chrome (Q's call: every modal matches
 * the chat card). Borderless Lisse glass, a centered grab pill at the top (the
 * whole header drags — no title-bar divider lines), hover-revealed ghost
 * actions + close in the corner, and invisible resize zones on ALL 8 edges.
 *
 * Extracted from chat-card.tsx so diff / terminal / file / spec / browser /
 * image / brain cards share the identical shell. The card passes its body as
 * children; the body owns its own height (typically a `height: card.h` column).
 */

import { useRef, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import { canvasZoom, CHROME, chromeFloorScale, FONT, glassChat, MEDIA_HEADER_H } from './ui';
import { dragBounds, resistAxis, settleInBounds } from './canvas-drag';
import { CornerResize } from './corner-resize';

/** Header chrome above the body (grab pill + optional title) — added to card.h
 *  so the bottom boundary clears the composer by the card's TRUE height. */
const SHELL_CHROME_H = 63;

export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
interface Geom { x: number; y: number; w: number; h: number; }

export interface ShellCard {
  id: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
}

/** Invisible resize zones — all 8 angles, hidden handles. Edges are thin strips
 *  inset from the corners; corners are small squares extending OUTWARD so they
 *  don't swallow the header buttons. */
const RESIZE_ZONES: Array<{ key: Edge; cursor: string; style: React.CSSProperties }> = [
  { key: 'n', cursor: 'ns-resize', style: { top: -5, left: 16, right: 16, height: 10 } },
  { key: 's', cursor: 'ns-resize', style: { bottom: -5, left: 16, right: 16, height: 10 } },
  { key: 'e', cursor: 'ew-resize', style: { top: 16, bottom: 16, right: -5, width: 10 } },
  { key: 'w', cursor: 'ew-resize', style: { top: 16, bottom: 16, left: -5, width: 10 } },
  { key: 'ne', cursor: 'nesw-resize', style: { top: -8, right: -8, width: 16, height: 16 } },
  { key: 'nw', cursor: 'nwse-resize', style: { top: -8, left: -8, width: 16, height: 16 } },
  { key: 'se', cursor: 'nwse-resize', style: { bottom: -8, right: -8, width: 16, height: 16 } },
  { key: 'sw', cursor: 'nesw-resize', style: { bottom: -8, left: -8, width: 16, height: 16 } },
];

/** New geometry for a resize drag. card.h is the BODY height (chrome sits on
 *  top), so a top/left grab repositions x/y while the opposite edge stays put. */
function resizeGeom(edge: Edge, dx: number, dy: number, start: Geom, minW: number, minH: number): Geom {
  let { x, y, w, h } = start;
  if (edge.includes('e')) w = start.w + dx;
  if (edge.includes('s')) h = start.h + dy;
  if (edge.includes('w')) { w = start.w - dx; x = start.x + dx; }
  if (edge.includes('n')) { h = start.h - dy; y = start.y + dy; }
  if (w < minW) { if (edge.includes('w')) x -= minW - w; w = minW; }
  if (h < minH) { if (edge.includes('n')) y -= minH - h; h = minH; }
  return { x, y, w, h };
}

export function GlassCardShell({
  card,
  minW,
  minH,
  title,
  badge,
  actions,
  onMove,
  onResize,
  onFocus,
  onClose,
  screenMap,
  cornerHandles,
  headerStyle = 'pill',
  icon,
  framed,
  children,
}: {
  card: ShellCard;
  minW: number;
  minH: number;
  /** Subtle centered label under the grab pill — the card's identity. */
  title?: ReactNode;
  /** Quiet right-of-title metadata (branch, status %, path tail). */
  badge?: ReactNode;
  /** Extra hover-ghost buttons, left of the close ✕ (e.g. dock, open). */
  actions?: ReactNode;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
  /** When set, the card renders OUT of the zoomed canvas layer at true device
   *  1:1, mapping its layer-local x/y onto screen itself (screen = zoom·(coord
   *  + pan)) and scaling its own size + chrome by the zoom — so it LOOKS the
   *  same as an in-layer card but has no CSS scale in its ancestry. The o8.md
   *  card uses this so CodeMirror's caret hit-testing (broken under any CSS
   *  scale in WebKit) works at every zoom. Drag/resize still divide pointer
   *  deltas by canvasZoom() and report layer-local coords, so only the rendered
   *  geometry changes. Off (=1) everywhere else. */
  screenMap?: { zoom: number; panX: number; panY: number } | null;
  /** Opt in to the unified corner-arc resize affordance (proximity reveal, off
   *  in grid mode) instead of the legacy invisible 8-zone handles. Rolling out
   *  one card kind at a time. */
  cornerHandles?: boolean;
  /** Header treatment: 'pill' (centered grab pill + title) or 'media' (icon +
   *  filename left-aligned, the strip drags — matches photo/video cards). */
  headerStyle?: 'pill' | 'media';
  /** Leading glyph for the media header (a ~12px svg with stroke currentColor). */
  icon?: ReactNode;
  /** Draw the frosted frame outline (the photo/video border) instead of the
   *  borderless treatment. Opt-in per kind, like the corner handles. */
  framed?: boolean;
  children: ReactNode;
}) {
  // Scale factor for a pulled-out card (1 when in-layer — every `* s` is then a
  // no-op, so non-spec cards are byte-identical).
  const s = screenMap ? screenMap.zoom : 1;
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; lastX: number; lastY: number } | null>(null);
  const settleRef = useRef<{ stop: () => void } | null>(null);
  const resizeRef = useRef<{ pointerId: number; edge: Edge; startX: number; startY: number; start: Geom } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [hovered, setHovered] = useState(false);

  const onResizeDown = (edge: Edge) => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic/stale pointer */ }
    resizeRef.current = { pointerId: event.pointerId, edge, startX: event.clientX, startY: event.clientY, start: { x: card.x, y: card.y, w: card.w, h: card.h } };
    setResizing(true);
  };
  const onResizeMove = (event: React.PointerEvent) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const zoom = canvasZoom();
    const next = resizeGeom(resize.edge, (event.clientX - resize.startX) / zoom, (event.clientY - resize.startY) / zoom, resize.start, minW, minH);
    onResize(card.id, next.w, next.h);
    if (next.x !== resize.start.x || next.y !== resize.start.y) onMove(card.id, next.x, next.y);
  };
  const onResizeUp = () => { resizeRef.current = null; setResizing(false); };

  // Header chrome above the body — shorter for the media strip. Feeds dragBounds
  // so the bottom boundary clears the composer by the card's TRUE height.
  const chromeH = headerStyle === 'media' ? MEDIA_HEADER_H : SHELL_CHROME_H;
  const startDrag = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    settleRef.current?.stop();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic/stale pointer */ }
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: card.x, originY: card.y, lastX: card.x, lastY: card.y };
    setDragging(true);
  };
  const moveDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = dragBounds(card.w, card.h + chromeH);
    const zoom = canvasZoom();
    const x = resistAxis(drag.originX + (event.clientX - drag.startX) / zoom, bounds.minX, bounds.maxX);
    const y = resistAxis(drag.originY + (event.clientY - drag.startY) / zoom, bounds.minY, bounds.maxY);
    drag.lastX = x;
    drag.lastY = y;
    onMove(card.id, x, y);
  };
  const endDrag = () => {
    const drag = dragRef.current;
    if (drag) {
      settleRef.current = settleInBounds(drag.lastX, drag.lastY, dragBounds(card.w, card.h + chromeH), (x, y) => onMove(card.id, x, y));
    }
    dragRef.current = null;
    setDragging(false);
  };
  const closeBtn = (
    <button
      type="button"
      aria-label="Close"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => onClose(card.id)}
      style={{ borderWidth: 0, background: 'transparent', padding: 3 * s, paddingLeft: 6 * s, paddingRight: 6 * s, fontSize: CHROME.closeSize * s, lineHeight: 1, color: 'var(--cnv-ink-muted)', cursor: 'pointer', fontFamily: FONT }}
      onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
    >
      <span aria-hidden style={{ pointerEvents: 'none' }}>✕</span>
    </button>
  );

  return (
    <motion.div
      initial={{ scale: 0.7, opacity: 0, y: 24 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={{ scale: 0.86, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 360, damping: 28 }}
      onPointerDownCapture={() => onFocus(card.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-glass-surface
      data-card-id={card.id}
      style={{
        position: 'absolute',
        left: screenMap ? screenMap.zoom * (card.x + screenMap.panX) : card.x,
        top: screenMap ? screenMap.zoom * (card.y + screenMap.panY) : card.y,
        width: card.w * s,
        zIndex: card.z,
        // Out-of-layer overlay container is pointerEvents:none so empty canvas
        // stays clickable through it — the card itself opts back in.
        ...(screenMap ? { pointerEvents: 'auto' as const } : null),
      }}
    >
      <SmoothCorners
        corners={{ radius: 22 * s }}
        shadowStrategy="box-shadow"
        style={{
          display: 'flex',
          flexDirection: 'column',
          ...glassChat(dragging || resizing),
          // Locked bench treatment: borderless + lighter shadow (matches the
          // chat card exactly — no title-bar lines, no heavy frame). `framed`
          // opts into the photo/video frosted-frame outline (terminal for now).
          border: framed ? '1px solid var(--cnv-edge)' : 'none',
          boxShadow: '0 14px 42px rgba(0, 0, 0, 0.24)',
        }}
      >
        {headerStyle === 'media' ? (
          /* Media header — icon + name left-aligned, the strip drags; actions +
             close reveal on the right on hover. Matches photo/video cards. */
          <div
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7 * s,
              height: MEDIA_HEADER_H * s,
              paddingLeft: 11 * s,
              paddingRight: 9 * s,
              cursor: dragging ? 'grabbing' : 'grab',
              touchAction: 'none',
              userSelect: 'none',
              flexShrink: 0,
            }}
          >
            {icon ? <span aria-hidden style={{ display: 'flex', flexShrink: 0, color: 'var(--cnv-ink-muted)', pointerEvents: 'none' }}>{icon}</span> : null}
            <span style={{ flex: 1, minWidth: 0, fontSize: CHROME.titleSize * s, fontWeight: CHROME.titleWeight, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', fontFamily: FONT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {title}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 1, opacity: hovered ? 1 : 0, pointerEvents: hovered ? 'auto' : 'none', transition: 'opacity 160ms ease', flexShrink: 0, ...(screenMap ? null : chromeFloorScale('center right')) }}>
              {actions}
              {closeBtn}
            </div>
          </div>
        ) : (
          <>
            {/* Header — centered grab pill, the whole strip drags. */}
            <div
              onPointerDown={startDrag}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'stretch',
                paddingTop: 9 * s,
                cursor: dragging ? 'grabbing' : 'grab',
                touchAction: 'none',
                userSelect: 'none',
                flexShrink: 0,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: (title ? 7 : 8) * s }}>
                <span aria-hidden style={{ width: 34 * s, height: 4 * s, borderRadius: 3 * s, background: 'var(--cnv-ink-muted)', opacity: 0.35 }} />
              </div>
              {title ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 * s, paddingLeft: 22 * s, paddingRight: 22 * s, paddingBottom: 11 * s, minWidth: 0 }}>
                  <span style={{ fontSize: CHROME.titleSize * s, fontWeight: CHROME.titleWeight, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', fontFamily: FONT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                    {title}
                  </span>
                  {badge ? (
                    <span style={{ fontSize: CHROME.metaSize * s, fontWeight: CHROME.metaWeight, color: 'var(--cnv-ink-muted)', fontFamily: FONT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0, maxWidth: '45%' }}>
                      {badge}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* Hover-revealed ghost actions + close — top-right, off when hidden so
                they never swallow the corner resize zone. The cluster scales with
                the canvas but floors to a clickable minimum (#1259). */}
            <div
              style={{
                position: 'absolute',
                top: 7 * s,
                right: 9 * s,
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                opacity: hovered ? 1 : 0,
                pointerEvents: hovered ? 'auto' : 'none',
                transition: 'opacity 160ms ease',
                zIndex: 7,
                ...(screenMap ? null : chromeFloorScale('top right')),
              }}
            >
              {actions}
              {closeBtn}
            </div>
          </>
        )}

        {children}
      </SmoothCorners>

      {/* Resize handles. Opt-in: the unified corner-arc affordance (reveals only
          at the hovered corner, hidden in grid mode) vs the legacy invisible
          8-zone handles. Siblings of SmoothCorners so the outward overhang isn't
          clipped by the corner mask. */}
      {cornerHandles ? (
        <CornerResize card={card} minW={minW} minH={minH} onMove={onMove} onResize={onResize} onResizingChange={setResizing} />
      ) : (
        RESIZE_ZONES.map((zone) => (
          <div
            key={zone.key}
            role="presentation"
            onPointerDown={onResizeDown(zone.key)}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            style={{ position: 'absolute', cursor: zone.cursor, touchAction: 'none', zIndex: zone.key.length === 2 ? 6 : 5, ...zone.style }}
          />
        ))
      )}
    </motion.div>
  );
}

/** A hover-ghost header action button — same treatment as the close ✕, for the
 *  optional `actions` slot (dock, open-in-panel, etc.). */
export function ShellAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
      style={{ borderWidth: 0, background: 'transparent', padding: 3, color: 'var(--cnv-ink-muted)', cursor: 'pointer', display: 'inline-flex' }}
      onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
    >
      <span aria-hidden style={{ display: 'inline-flex', pointerEvents: 'none' }}>
        {children}
      </span>
    </button>
  );
}
