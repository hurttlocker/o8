'use client';

/**
 * Video cards (#video-cards) — drop a clip on the canvas and it sits there as
 * a glass object you can play, scrub, drag, resize, and keep. Built as the
 * photo card's sibling: a floating filename pill above (the drag handle + the
 * close ✕), the clip below with native controls, a W×H chip while resizing, an
 * aspect-locked corner grip.
 *
 * The clip itself swallows its pointer events so the native scrubber/volume
 * work — you drag the card by the pill, not the video. The bytes live in
 * IndexedDB (canvas-media-store); this card just renders the object URL the
 * page minted for it.
 */

import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import { canvasZoom, FONT, IMG_MIN_W, RESIZE_ARC, glass } from './ui';
import { dragBounds, resistAxis, settleInBounds } from './canvas-drag';

export interface VideoCard {
  id: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  /** natural width / height — resize stays aspect-locked, like photos. */
  aspect: number;
  /** object URL minted from the IndexedDB blob (session-scoped, re-created on reload). */
  src: string;
  name: string;
  /** durable IndexedDB key — the snapshot carries this, not the bytes. */
  mediaId: string;
}

const MONO = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

export function VideoGlassCard({
  card,
  onMove,
  onResize,
  onFocus,
  onClose,
}: {
  card: VideoCard;
  onMove: (id: number, x: number, y: number) => void;
  /** Aspect-locked — width drives, the card computes height. */
  onResize: (id: number, w: number) => void;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean; lastX: number; lastY: number } | null>(null);
  const settleRef = useRef<{ stop: () => void } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; originW: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [hovered, setHovered] = useState(false);

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
        // Tap-vs-drag threshold in SCREEN px; position delta divides by zoom.
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
        if (!drag || !drag.moved) return;
        // Spring the last few resisted px back in-bounds.
        settleRef.current = settleInBounds(drag.lastX, drag.lastY, dragBounds(card.w, card.h), (x, y) => onMove(card.id, x, y));
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
      {/* Filename pill — the drag handle + close, floating above the clip. */}
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
          <path d="m22 8-6 4 6 4V8Z" /><rect width="14" height="12" x="2" y="6" rx="2" ry="2" />
        </svg>
        <span style={{ fontSize: 9.5, fontWeight: 300, color: 'var(--cnv-ink)', letterSpacing: '-0.05px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {card.name}
        </span>
        {hovered ? (
          <button
            type="button"
            aria-label="Remove video"
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

      {/* W×H chip — only while the corner grip is live. */}
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

      {/* ~5px frosted rim — the defined outline (reference-matched). Blur is
          suppressed while dragging/resizing so the moving glass never flickers
          the native vibrancy (see canvas drag flicker). */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 18,
          ...glass(false, dragging || resizing),
          boxShadow: '0 10px 28px rgba(0, 0, 0, 0.22)',
        }}
      />
      {/* The clip — squircle corners, inset inside the rim; native controls. It
          swallows its own pointer events (stopPropagation) so play/scrub/volume
          work without ever starting a card drag — drag the card by the pill. */}
      <SmoothCorners corners={{ radius: 13 }} autoEffects={false} style={{ position: 'absolute', inset: 5, background: '#000' }}>
        <video
          src={card.src}
          controls
          preload="metadata"
          playsInline
          // Paint the first frame as a still "poster" so the card reads as a
          // visual thumbnail at rest (like a photo) — the whole point is to
          // glance and be reminded. A hair-past-zero seek forces WebKit to
          // decode + show frame 0 instead of a black box.
          onLoadedMetadata={(event) => {
            const el = event.currentTarget;
            if (el.currentTime < 0.05) { try { el.currentTime = 0.05; } catch { /* seek not ready yet */ } }
          }}
          onPointerDownCapture={(event) => event.stopPropagation()}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            display: 'block',
            background: '#000',
          }}
        />
      </SmoothCorners>

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
          <path d={RESIZE_ARC.d} stroke="var(--cnv-ink-muted)" strokeWidth={2.5} strokeLinecap="round" />
        </svg>
      </div>
    </motion.div>
  );
}
