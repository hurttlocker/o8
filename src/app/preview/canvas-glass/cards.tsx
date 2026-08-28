'use client';

/**
 * Canvas object cards — the component vocabulary (#1232). Every kind of
 * thing the canvas can hold renders as a glass card with the shared
 * frosted-frame anatomy: a mini title bar, a kind-specific body, a position chip while
 * dragging, and a selection ring on click.
 */

import { memo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { canvasZoom, CARD_WIDTH, FONT, TONE_DOT, glass, type MockCard } from './ui';
import { dragBounds, resistAxis, settleInBounds } from './canvas-drag';

/** MockCards are auto-height (no stored h) — a nominal full height for the
 *  bottom drag boundary so they don't bury under the composer. */
const CARD_NOMINAL_H = 130;

export const CanvasCard = memo(function CanvasCard({
  card,
  selected,
  onMove,
  onSelect,
}: {
  card: MockCard;
  selected: boolean;
  onMove: (id: number, x: number, y: number) => void;
  onSelect: (id: number) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; lastX: number; lastY: number } | null>(null);
  const settleRef = useRef<{ stop: () => void } | null>(null);
  const [dragging, setDragging] = useState(false);
  const working = card.kind === 'packet' && card.tone === 'working';
  const width = CARD_WIDTH[card.kind];
  return (
    <motion.div
      initial={{ scale: 0.62, opacity: 0, y: 26 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 28, delay: card.entryDelay ?? 0 }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        settleRef.current?.stop();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: card.x, originY: card.y, lastX: card.x, lastY: card.y };
        setDragging(true);
        onSelect(card.id);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const bounds = dragBounds(width, CARD_NOMINAL_H);
        const zoom = canvasZoom();
        const x = resistAxis(drag.originX + (event.clientX - drag.startX) / zoom, bounds.minX, bounds.maxX);
        const y = resistAxis(drag.originY + (event.clientY - drag.startY) / zoom, bounds.minY, bounds.maxY);
        drag.lastX = x;
        drag.lastY = y;
        onMove(card.id, x, y);
      }}
      onPointerUp={() => {
        const drag = dragRef.current;
        if (drag) {
          settleRef.current = settleInBounds(drag.lastX, drag.lastY, dragBounds(width, CARD_NOMINAL_H), (x, y) => onMove(card.id, x, y));
        }
        dragRef.current = null;
        setDragging(false);
      }}
      style={{
        position: 'absolute',
        left: card.x,
        top: card.y,
        width,
        borderRadius: 14,
        cursor: 'grab',
        touchAction: 'none',
        // Images sit "in the back" — the desktop-on-desktop pile.
        zIndex: card.kind === 'image' ? 2 : 3,
      }}
    >
      {/* Position chip while dragging — live W/H dims. */}
      {dragging ? (
        <div
          style={{
            position: 'absolute',
            top: -24,
            left: 0,
            display: 'flex',
            gap: 4,
            fontSize: 9,
            fontWeight: 400,
            color: 'var(--cnv-ink)',
            fontFamily: FONT,
            pointerEvents: 'none',
          }}
        >
          <span style={{ paddingTop: 2, paddingBottom: 2, paddingLeft: 6, paddingRight: 6, borderRadius: 6, ...glass(true), boxShadow: 'none' }}>
            X {Math.round(card.x)}
          </span>
          <span style={{ paddingTop: 2, paddingBottom: 2, paddingLeft: 6, paddingRight: 6, borderRadius: 6, ...glass(true), boxShadow: 'none' }}>
            Y {Math.round(card.y)}
          </span>
        </div>
      ) : null}
      <motion.div
        animate={working ? { scale: [1, 1.015, 1], opacity: [1, 0.93, 1] } : { scale: 1, opacity: 1 }}
        transition={working ? { duration: 3.2, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.2 }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 14,
          overflow: 'hidden',
          ...glass(),
          ...(selected ? { borderColor: 'var(--cnv-ink-muted)' } : null),
        }}
      >
        <CardTitleBar card={card} />
        <CardBody card={card} />
      </motion.div>
    </motion.div>
  );
});

function CardTitleBar({ card }: { card: MockCard }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        minWidth: 0,
        paddingTop: 9,
        paddingRight: 12,
        paddingBottom: card.kind === 'packet' ? 0 : 8,
        paddingLeft: 12,
        ...(card.kind !== 'packet' ? { borderBottom: '1px solid var(--cnv-edge)' } : null),
      }}
    >
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: TONE_DOT[card.tone] }} />
      <span style={{ fontSize: card.kind === 'packet' ? 13.5 : 11.5, fontWeight: 300, letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: FONT }}>
        {card.title}
      </span>
    </div>
  );
}

function CardBody({ card }: { card: MockCard }) {
  if (card.kind === 'browser') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8, paddingRight: 12, paddingBottom: 12, paddingLeft: 12 }}>
        <span
          style={{
            alignSelf: 'flex-start',
            fontSize: 9.5,
            fontWeight: 300,
            color: 'var(--cnv-ink-muted)',
            paddingTop: 3,
            paddingBottom: 3,
            paddingLeft: 9,
            paddingRight: 9,
            borderRadius: 999,
            border: '1px solid var(--cnv-edge)',
            fontFamily: FONT,
          }}
        >
          {card.meta}
        </span>
        <div style={{ height: 64, borderRadius: 8, border: '1px dashed var(--cnv-edge)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink-muted)" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
            <circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        </div>
      </div>
    );
  }
  if (card.kind === 'terminal') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingTop: 8, paddingRight: 12, paddingBottom: 11, paddingLeft: 12, fontFamily: 'var(--font-mono, monospace)', fontSize: 9, lineHeight: 1.6 }}>
        <span style={{ color: 'var(--cnv-ink-muted)' }}>$ o8 packet info</span>
        <span style={{ color: 'var(--cnv-ink)' }}>lane: inline-3 · branch: main</span>
        <span style={{ color: 'var(--cnv-ink-muted)' }}>$ ▍</span>
      </div>
    );
  }
  if (card.kind === 'review') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingTop: 8, paddingRight: 12, paddingBottom: 11, paddingLeft: 12, fontFamily: 'var(--font-mono, monospace)', fontSize: 9, lineHeight: 1.6 }}>
        <span style={{ color: 'rgba(110, 231, 183, 0.9)' }}>+ const gate = review(diff)</span>
        <span style={{ color: 'rgba(252, 165, 165, 0.85)' }}>- merge(diff) // unreviewed</span>
        <span style={{ color: 'var(--cnv-ink-muted)' }}>  2 files · +14 −3</span>
      </div>
    );
  }
  if (card.kind === 'image' && card.src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={card.src}
        alt={card.title}
        draggable={false}
        style={{ display: 'block', width: '100%', maxHeight: 220, objectFit: 'cover', pointerEvents: 'none' }}
      />
    );
  }
  // packet — meta line under the title, the original anatomy
  return (
    <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)', letterSpacing: '0.01em', paddingTop: 5, paddingRight: 13, paddingBottom: 11, paddingLeft: 25, fontFamily: FONT }}>
      {card.meta}
    </span>
  );
}
