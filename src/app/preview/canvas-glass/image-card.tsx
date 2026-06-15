'use client';

/**
 * Image cards — photos surface the way the a creator reference does
 * (#1232): a floating filename pill above the image, the picture itself
 * dissolving into the canvas at its bottom edge, a W×H chip while
 * resizing, and drag-together STACKS — drop one photo onto another and
 * they collapse into a fanned deck to save space; click a deck to spread
 * it back out.
 *
 * No glass body — the photo IS the card. Squircle top corners via Lisse;
 * the bottom mask makes the lower corners moot.
 */

import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import { canvasZoom, FONT, IMG_MIN_W, MEDIA_HEADER_H, MEDIA_RIM, RESIZE_ARC, glassMedia } from './ui';
import { dragBounds, resistAxis, settleInBounds } from './canvas-drag';

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

export function ImageGlassCard({
  card,
  onMove,
  onResize,
  onFocus,
  onDrop,
  onTap,
  onClose,
}: {
  card: ImageCard;
  onMove: (id: number, x: number, y: number) => void;
  /** Aspect-locked — width drives, the card computes height. */
  onResize: (id: number, w: number) => void;
  onFocus: (id: number) => void;
  /** Pointer released after a real drag — page hit-tests for stacking. */
  onDrop: (id: number, centerX: number, centerY: number) => void;
  /** Pointer released without travel — spreads a stack back out. */
  onTap: (id: number) => void;
  onClose: (id: number) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean; lastX: number; lastY: number } | null>(null);
  const settleRef = useRef<{ stop: () => void } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; originW: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [hovered, setHovered] = useState(false);

  const stack = card.items.length > 1;
  const lead = card.items[0];

  return (
    <motion.div
      initial={{ scale: 0.7, opacity: 0, y: 24 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
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
      onPointerUp={(event) => {
        const drag = dragRef.current;
        dragRef.current = null;
        setDragging(false);
        if (!drag) return;
        if (drag.moved) {
          // Stacking hit-test first (page may absorb/reposition this card), then
          // spring the last few resisted px back in-bounds — a no-op if the card
          // was consumed into a deck or already settled inside the walls.
          onDrop(card.id, event.clientX, event.clientY);
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
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
          <rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
        </svg>
        <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: 400, color: 'var(--cnv-ink)', letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {stack ? `${card.items.length} images` : lead?.name}
        </span>
        {resizing ? (
          <span style={{ flexShrink: 0, fontFamily: MONO, fontSize: 9.5, color: 'var(--cnv-ink-muted)' }}>{Math.round(card.w)}×{Math.round(card.h)}</span>
        ) : hovered ? (
          <button
            type="button"
            aria-label="Remove image"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onClose(card.id)}
            style={{ borderWidth: 0, background: 'transparent', padding: 2, fontSize: 12, lineHeight: 1, color: 'var(--cnv-ink-muted)', cursor: 'pointer', fontFamily: FONT, flexShrink: 0 }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            ✕
          </button>
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

      {/* Off-edge resize handle — a squircle corner arc CONCENTRIC with the
          card's own corner (lisse-generated so the curve matches), sitting just
          outside the bottom-right. Drag it to resize (aspect-locked). */}
      <div
        role="presentation"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic/stale pointer */ }
          resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, originW: card.w };
          setResizing(true);
        }}
        onPointerMove={(event) => {
          const resize = resizeRef.current;
          if (!resize || resize.pointerId !== event.pointerId) return;
          onResize(card.id, Math.max(IMG_MIN_W, resize.originW + (event.clientX - resize.startX) / canvasZoom()));
        }}
        onPointerUp={() => { resizeRef.current = null; setResizing(false); }}
        style={{
          position: 'absolute',
          left: '100%',
          top: '100%',
          width: RESIZE_ARC.size,
          height: RESIZE_ARC.size,
          transform: 'translate(-7px, -7px)',
          cursor: 'nwse-resize',
          touchAction: 'none',
          opacity: resizing || hovered ? 1 : 0,
          transition: 'opacity 140ms ease',
        }}
      >
        <svg width={RESIZE_ARC.size} height={RESIZE_ARC.size} viewBox={`0 0 ${RESIZE_ARC.size} ${RESIZE_ARC.size}`} fill="none" aria-hidden style={{ display: 'block', overflow: 'visible' }}>
          <path d={RESIZE_ARC.d} stroke="var(--cnv-media-rim)" strokeWidth={7} strokeLinecap="round" />
        </svg>
      </div>
    </motion.div>
  );
}
