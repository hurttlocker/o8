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
import { FONT, IMG_MIN_W, glass } from './ui';

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
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
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
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic/stale pointer */ }
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: card.x, originY: card.y, moved: false };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) < 5) return;
        drag.moved = true;
        onMove(card.id, Math.max(4, drag.originX + dx), Math.max(40, drag.originY + dy));
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        dragRef.current = null;
        setDragging(false);
        if (!drag) return;
        if (drag.moved) {
          onDrop(card.id, event.clientX, event.clientY);
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
      {/* Filename pill — floats above the photo, reference-style. */}
      <div
        style={{
          position: 'absolute',
          top: -28,
          left: 0,
          maxWidth: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 22,
          paddingLeft: 9,
          paddingRight: hovered ? 4 : 9,
          borderRadius: 999,
          ...glass(true),
          boxShadow: 'none',
        }}
      >
        <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
          <rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
        </svg>
        <span style={{ fontSize: 9.5, fontWeight: 300, color: 'var(--cnv-ink)', letterSpacing: '-0.05px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {stack ? `${card.items.length} images` : lead?.name}
        </span>
        {hovered ? (
          <button
            type="button"
            aria-label="Remove image"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onClose(card.id)}
            style={{ borderWidth: 0, background: 'transparent', padding: 2, fontSize: 9.5, color: 'var(--cnv-ink-muted)', cursor: 'pointer', fontFamily: FONT, flexShrink: 0 }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            ✕
          </button>
        ) : null}
      </div>

      {/* W×H chip — only while the corner grip is live, reference-style. */}
      {resizing ? (
        <div
          style={{
            position: 'absolute',
            top: -28,
            right: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: 22,
            paddingLeft: 8,
            paddingRight: 8,
            borderRadius: 999,
            fontFamily: MONO,
            fontSize: 9,
            color: 'var(--cnv-ink)',
            ...glass(true),
            boxShadow: 'none',
          }}
        >
          <span style={{ color: 'var(--cnv-ink-muted)' }}>W</span>
          {Math.round(card.w)}
          <span style={{ color: 'var(--cnv-ink-muted)' }}>H</span>
          {Math.round(card.h)}
        </div>
      ) : null}

      {/* Deck ghosts — the fanned edges behind a stack. */}
      {stack ? (
        <>
          <div aria-hidden style={{ position: 'absolute', inset: 0, borderRadius: 16, background: 'var(--cnv-tint)', border: '1px solid var(--cnv-edge)', transform: 'rotate(-3.2deg) translate(-7px, 5px)' }} />
          <div aria-hidden style={{ position: 'absolute', inset: 0, borderRadius: 16, background: 'var(--cnv-tint-deep)', border: '1px solid var(--cnv-edge)', transform: 'rotate(2.4deg) translate(6px, 3px)' }} />
        </>
      ) : null}

      {/* The photo — squircle corners, bottom edge dissolves into canvas. */}
      <SmoothCorners corners={{ radius: 16 }} autoEffects={false} style={{ position: 'absolute', inset: 0 }}>
        {lead ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={lead.src}
            alt={lead.name}
            draggable={false}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
              pointerEvents: 'none',
              ...(stack
                ? {}
                : {
                  maskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 66%, rgba(0,0,0,0) 100%)',
                  WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 66%, rgba(0,0,0,0) 100%)',
                }),
            }}
          />
        ) : null}
      </SmoothCorners>

      {/* Stack count — top-right of the deck. */}
      {stack ? (
        <span
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
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
            ...glass(true),
            boxShadow: 'none',
          }}
        >
          ×{card.items.length}
        </span>
      ) : null}

      {/* Corner resize grip — aspect-locked. */}
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
          onResize(card.id, Math.max(IMG_MIN_W, resize.originW + event.clientX - resize.startX));
        }}
        onPointerUp={() => { resizeRef.current = null; setResizing(false); }}
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 18,
          height: 18,
          cursor: 'nwse-resize',
          touchAction: 'none',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'flex-end',
          paddingRight: 4,
          paddingBottom: 4,
          opacity: resizing || hovered ? 0.8 : 0,
        }}
      >
        <svg width={9} height={9} viewBox="0 0 9 9" aria-hidden>
          <path d="M8 1 1 8M8 5 5 8" stroke="var(--cnv-ink-muted)" strokeWidth="1.2" strokeLinecap="round" fill="none" />
        </svg>
      </div>
    </motion.div>
  );
}
