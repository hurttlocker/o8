'use client';

/**
 * Image cards — photos surface as free-floating framed objects on the board
 * (#1232): a floating filename pill above the image, the picture itself
 * dissolving into the canvas at its bottom edge, a W×H chip while
 * resizing, and drag-together STACKS — drop one photo onto another and
 * they collapse into a fanned deck to save space; tap a deck to flip
 * through it (cycles to the next photo).
 *
 * No glass body — the photo IS the card. Squircle top corners via Lisse;
 * the bottom mask makes the lower corners moot.
 */

import { memo, useRef, useState, type CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import { canvasZoom, CHROME, chromeFloorScale, FONT, IMG_MIN_W, MEDIA_HEADER_H, MEDIA_RIM, glassMedia } from './ui';
import { dragBounds, resistAxis, settleInBounds } from './canvas-drag';
import { CornerResize } from './corner-resize';
import { useCanvasRenderProbe } from './perf/render-probe';

export interface ImageItem {
  src: string;
  name: string;
}

export interface ImageCard {
  id: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  /** natural width / height of the lead photo — resize stays aspect-locked. */
  aspect: number;
  /** length > 1 = a stack (deck). items[0] is the visible top photo. */
  items: ImageItem[];
}

const MONO = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

/** Circular ‹ › deck-flip button, pinned to a photo's left/right edge. */
function navArrowStyle(side: 'left' | 'right'): CSSProperties {
  return {
    position: 'absolute',
    top: '50%',
    [side]: MEDIA_RIM + 8,
    transform: 'translateY(-50%)',
    width: 30,
    height: 30,
    borderRadius: 999,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 0,
    cursor: 'pointer',
    color: '#ffffff',
    background: 'rgba(20, 22, 26, 0.46)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    boxShadow: '0 2px 10px rgba(0, 0, 0, 0.28)',
  } as CSSProperties;
}

export const ImageGlassCard = memo(function ImageGlassCard({
  card,
  isDropTarget,
  onMove,
  onResize,
  onFocus,
  onDrop,
  onTap,
  onCycle,
  onSpread,
  onClose,
}: {
  card: ImageCard;
  /** True while another photo is being dragged over this one — shows the
   *  "Drop to stack" highlight. */
  isDropTarget?: boolean;
  onMove: (id: number, x: number, y: number) => void;
  /** Aspect-locked corner resize — CornerResize derives h from w; both land. */
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  /** Pointer released after a real drag — page hit-tests (in canvas coords,
   *  from the card's own geometry) for stacking. */
  onDrop: (id: number) => void;
  /** Pointer released without travel — flips the deck to the next photo. */
  onTap: (id: number) => void;
  /** ‹ › deck arrows — flip to prev (dir<0) / next (dir≥0) photo. */
  onCycle: (id: number, dir: number) => void;
  /** Separate a deck back into individual cards. */
  onSpread: (id: number) => void;
  onClose: (id: number) => void;
}) {
  useCanvasRenderProbe('image', card.id);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean; lastX: number; lastY: number } | null>(null);
  const settleRef = useRef<{ stop: () => void } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [hovered, setHovered] = useState(false);

  const stack = card.items.length > 1;
  const lead = card.items[0];

  return (
    <motion.div
      initial={{ scale: 0.7, opacity: 0, y: 24 }}
      animate={{ scale: isDropTarget ? 1.05 : 1, opacity: 1, y: 0 }}
      exit={{ scale: 0.86, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 360, damping: 28 }}
      onPointerDownCapture={() => onFocus(card.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-card-id={card.id}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        settleRef.current?.stop();
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic/stale pointer */ }
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: card.x, originY: card.y, moved: false, lastX: card.x, lastY: card.y };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        // Tap-vs-drag threshold stays in SCREEN px (physical travel); the
        // position delta divides by zoom to track the cursor like every other
        // canvas drag site.
        if (!drag.moved && Math.hypot(dx, dy) < 5) return;
        drag.moved = true;
        const zoom = canvasZoom();
        const bounds = dragBounds(card.w, card.h);
        const x = resistAxis(drag.originX + dx / zoom, bounds.minX, bounds.maxX);
        const y = resistAxis(drag.originY + dy / zoom, bounds.minY, bounds.maxY);
        drag.lastX = x;
        drag.lastY = y;
        onMove(card.id, x, y);
      }}
      onPointerUp={() => {
        const drag = dragRef.current;
        dragRef.current = null;
        setDragging(false);
        if (!drag) return;
        if (drag.moved) {
          // Stacking hit-test first (page may absorb/reposition this card), then
          // spring the last few resisted px back in-bounds — a no-op if the card
          // was consumed into a deck or already settled inside the walls.
          onDrop(card.id);
          settleRef.current = settleInBounds(drag.lastX, drag.lastY, dragBounds(card.w, card.h), (x, y) => onMove(card.id, x, y));
        } else if (stack) {
          onTap(card.id);
        }
      }}
      style={{
        position: 'absolute',
        left: card.x,
        top: card.y,
        width: card.w,
        height: card.h,
        zIndex: card.z,
        cursor: dragging ? 'grabbing' : 'grab',
        touchAction: 'none',
        userSelect: 'none',
        fontFamily: FONT,
      }}
    >
      {/* Deck ghosts — the fanned edges behind a stack. */}
      {stack ? (
        <>
          <div aria-hidden style={{ position: 'absolute', inset: 0, borderRadius: 16, background: 'var(--cnv-tint)', border: '1px solid var(--cnv-edge)', transform: 'rotate(-3.2deg) translate(-7px, 5px)' }} />
          <div aria-hidden style={{ position: 'absolute', inset: 0, borderRadius: 16, background: 'var(--cnv-tint-deep)', border: '1px solid var(--cnv-edge)', transform: 'rotate(2.4deg) translate(6px, 3px)' }} />
        </>
      ) : null}

      {/* The grey frosted frame — the card bounds. Media insets MEDIA_RIM on the
          sides/bottom and sits below a MEDIA_HEADER_H header strip on top (the
          reference look). Blur SUPPRESSED while dragging/resizing so the moving
          glass never flickers the native vibrancy (see canvas drag flicker). */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 18,
          ...glassMedia(dragging || resizing),
          boxShadow: '0 10px 28px rgba(0, 0, 0, 0.22)',
        }}
      />
      {/* Header strip — icon + filename on the frosted frame top (reference). */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: MEDIA_HEADER_H, display: 'flex', alignItems: 'center', gap: 7, paddingLeft: 11, paddingRight: 9, fontFamily: FONT }}>
        <svg width={CHROME.iconSize} height={CHROME.iconSize} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
          <rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
        </svg>
        <span style={{ flex: 1, minWidth: 0, fontSize: CHROME.titleSize, fontWeight: CHROME.titleWeight, color: 'var(--cnv-ink)', letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {stack ? `${card.items.length} images` : lead?.name}
        </span>
        {resizing ? (
          <span style={{ flexShrink: 0, fontFamily: MONO, fontSize: CHROME.metaSize, color: 'var(--cnv-ink-muted)' }}>{Math.round(card.w)}×{Math.round(card.h)}</span>
        ) : hovered ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            {stack ? (
              <button
                type="button"
                aria-label="Separate stack"
                title="Separate"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onSpread(card.id)}
                style={{ borderWidth: 0, background: 'transparent', padding: 2, lineHeight: 0, color: 'var(--cnv-ink-muted)', cursor: 'pointer', display: 'inline-flex', ...chromeFloorScale('center right') }}
                onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
              >
                <svg width={CHROME.iconSize} height={CHROME.iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ pointerEvents: 'none' }}>
                  <rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" />
                </svg>
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Remove image"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onClose(card.id)}
              style={{ borderWidth: 0, background: 'transparent', padding: 2, fontSize: CHROME.closeSize, lineHeight: 1, color: 'var(--cnv-ink-muted)', cursor: 'pointer', fontFamily: FONT, ...chromeFloorScale('center right') }}
              onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
              onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
            >
              <span aria-hidden style={{ pointerEvents: 'none' }}>✕</span>
            </button>
          </span>
        ) : null}
      </div>
      {/* The photo — squircle, below the header with the grey rim on the other sides. */}
      <SmoothCorners corners={{ radius: 11 }} autoEffects={false} style={{ position: 'absolute', top: MEDIA_HEADER_H, left: MEDIA_RIM, right: MEDIA_RIM, bottom: MEDIA_RIM }}>
        {lead ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={lead.src}
            alt={lead.name}
            draggable={false}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }}
          />
        ) : null}
      </SmoothCorners>

      {/* Deck nav — ‹ › flip arrows on hover (tapping the photo also flips). */}
      {stack && hovered ? (
        <>
          <button type="button" aria-label="Previous photo" onPointerDown={(event) => event.stopPropagation()} onClick={() => onCycle(card.id, -1)} style={navArrowStyle('left')}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ pointerEvents: 'none' }}><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <button type="button" aria-label="Next photo" onPointerDown={(event) => event.stopPropagation()} onClick={() => onCycle(card.id, 1)} style={navArrowStyle('right')}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ pointerEvents: 'none' }}><path d="m9 18 6-6-6-6" /></svg>
          </button>
        </>
      ) : null}

      {/* Drop-to-stack highlight on the card a dragged photo is hovering over. */}
      {isDropTarget ? (
        <div aria-hidden style={{ position: 'absolute', inset: 0, borderRadius: 18, borderWidth: 2, borderStyle: 'solid', borderColor: '#ff7a18', boxShadow: '0 0 0 5px rgba(255, 122, 24, 0.20), 0 14px 36px rgba(255, 122, 24, 0.28)', pointerEvents: 'none', display: 'flex', alignItems: 'flex-start', justifyContent: 'center' }}>
          <span style={{ marginTop: MEDIA_HEADER_H + 10, paddingTop: 5, paddingBottom: 5, paddingLeft: 12, paddingRight: 12, borderRadius: 999, background: '#ff7a18', color: '#ffffff', fontSize: 11, fontWeight: 600, letterSpacing: '-0.1px', fontFamily: FONT, boxShadow: '0 4px 14px rgba(0, 0, 0, 0.35)' }}>Drop to stack</span>
        </div>
      ) : null}

      {/* Stack count — top-right of the deck. */}
      {stack ? (
        <span
          style={{
            position: 'absolute',
            top: MEDIA_HEADER_H + 6,
            right: MEDIA_RIM + 4,
            height: 18,
            paddingLeft: 7,
            paddingRight: 7,
            borderRadius: 999,
            display: 'inline-flex',
            alignItems: 'center',
            fontSize: 9,
            fontWeight: 400,
            color: 'var(--cnv-ink)',
            fontFamily: FONT,
            ...glassMedia(dragging),
            boxShadow: 'none',
          }}
        >
          ×{card.items.length}
        </span>
      ) : null}

      {/* Unified corner-arc resize — reveals only at the hovered corner, hidden
          in grid mode. Aspect-LOCKED (photos read best at their natural ratio),
          so corners only — no edges, which can't change a locked ratio. */}
      <CornerResize card={card} minW={IMG_MIN_W} minH={90} aspect={card.aspect} edges={false} onMove={onMove} onResize={onResize} onResizingChange={setResizing} />
    </motion.div>
  );
});
