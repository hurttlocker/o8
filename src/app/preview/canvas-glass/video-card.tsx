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

import { memo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import { canvasZoom, CHROME, chromeFloorScale, FONT, IMG_MIN_W, MEDIA_HEADER_H, MEDIA_RIM, glassMedia } from './ui';
import { dragBounds, resistAxis, settleInBounds } from './canvas-drag';
import { CornerResize } from './corner-resize';

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
  /** first-frame thumbnail (data URL) for the minimap — captured on load. */
  poster?: string;
}

const MONO = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

export const VideoGlassCard = memo(function VideoGlassCard({
  card,
  onMove,
  onResize,
  onFocus,
  onClose,
  onPoster,
}: {
  card: VideoCard;
  onMove: (id: number, x: number, y: number) => void;
  /** Aspect-locked corner resize — CornerResize derives h from w; both land. */
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
  /** First-frame thumbnail (data URL) captured once on load — feeds the minimap. */
  onPoster?: (id: number, dataUrl: string) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean; lastX: number; lastY: number } | null>(null);
  const settleRef = useRef<{ stop: () => void } | null>(null);
  const posterDoneRef = useRef(false);
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
      {/* The grey frosted frame — the card bounds. The clip insets MEDIA_RIM on
          the sides/bottom and sits below a MEDIA_HEADER_H header strip on top
          (the reference look). Blur SUPPRESSED while dragging/resizing so the
          moving glass never flickers the native vibrancy. */}
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
          <path d="m22 8-6 4 6 4V8Z" /><rect width="14" height="12" x="2" y="6" rx="2" ry="2" />
        </svg>
        <span style={{ flex: 1, minWidth: 0, fontSize: CHROME.titleSize, fontWeight: CHROME.titleWeight, color: 'var(--cnv-ink)', letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {card.name}
        </span>
        {resizing ? (
          <span style={{ flexShrink: 0, fontFamily: MONO, fontSize: CHROME.metaSize, color: 'var(--cnv-ink-muted)' }}>{Math.round(card.w)}×{Math.round(card.h)}</span>
        ) : hovered ? (
          <button
            type="button"
            aria-label="Remove video"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onClose(card.id)}
            style={{ borderWidth: 0, background: 'transparent', padding: 2, fontSize: CHROME.closeSize, lineHeight: 1, color: 'var(--cnv-ink-muted)', cursor: 'pointer', fontFamily: FONT, flexShrink: 0, ...chromeFloorScale('center right') }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            <span aria-hidden style={{ pointerEvents: 'none' }}>✕</span>
          </button>
        ) : null}
      </div>
      {/* The clip — squircle, below the header with the grey rim on the other
          sides; native controls. It swallows its own pointer events
          (stopPropagation) so play/scrub/volume work without ever starting a
          card drag — drag the card by the header. */}
      <SmoothCorners corners={{ radius: 11 }} autoEffects={false} style={{ position: 'absolute', top: MEDIA_HEADER_H, left: MEDIA_RIM, right: MEDIA_RIM, bottom: MEDIA_RIM, background: '#000' }}>
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
          // First decoded frame → a small JPEG poster, captured ONCE. The minimap
          // can't decode the blob video URL as an image, so it renders this still
          // (like a photo). blob URLs are same-origin, so the canvas isn't tainted.
          onSeeked={(event) => {
            if (posterDoneRef.current || !onPoster) return;
            const el = event.currentTarget;
            const vw = el.videoWidth;
            const vh = el.videoHeight;
            if (!vw || !vh) return;
            try {
              const maxEdge = 256;
              const factor = Math.min(1, maxEdge / Math.max(vw, vh));
              const canvas = document.createElement('canvas');
              canvas.width = Math.max(1, Math.round(vw * factor));
              canvas.height = Math.max(1, Math.round(vh * factor));
              const ctx = canvas.getContext('2d');
              if (!ctx) return;
              ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
              posterDoneRef.current = true;
              onPoster(card.id, canvas.toDataURL('image/jpeg', 0.7));
            } catch { /* frame not drawable yet — leave the placeholder */ }
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

      {/* Unified corner-arc resize — reveals only at the hovered corner, hidden
          in grid mode. Aspect-LOCKED (clips read best at their natural ratio),
          so corners only — no edges, which can't change a locked ratio. */}
      <CornerResize card={card} minW={IMG_MIN_W} minH={90} aspect={card.aspect} edges={false} onMove={onMove} onResize={onResize} onResizingChange={setResizing} />
    </motion.div>
  );
});
