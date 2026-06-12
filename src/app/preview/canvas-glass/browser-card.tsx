'use client';

/**
 * Browser cards — a REAL browser pane on the canvas (#1232). URL bar +
 * iframe in the same squircle glass shell the terminals use. Defaults to
 * the app's own dashboard (always frameable); external sites work when
 * they allow framing, and the hint line says so when they don't.
 */

import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import { FONT, TERM_MIN_H, TERM_MIN_W, glass } from './ui';

export interface BrowserCard {
  id: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  url: string;
}

function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (/^localhost[:/]/.test(value) || /^127\.0\.0\.1[:/]/.test(value)) return `http://${value}`;
  return `https://${value}`;
}

export function BrowserGlassCard({
  card,
  onMove,
  onResize,
  onFocus,
  onNavigate,
  onClose,
}: {
  card: BrowserCard;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  onNavigate: (id: number, url: string) => void;
  onClose: (id: number) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; originW: number; originH: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [urlDraft, setUrlDraft] = useState(card.url);

  return (
    <motion.div
      initial={{ scale: 0.7, opacity: 0, y: 24 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={{ scale: 0.86, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 360, damping: 28 }}
      onPointerDownCapture={() => onFocus(card.id)}
      style={{
        position: 'absolute',
        left: card.x,
        top: card.y,
        width: card.w,
        zIndex: card.z,
      }}
    >
      <SmoothCorners
        corners={{ radius: 14 }}
        shadowStrategy="box-shadow"
        style={{ display: 'flex', flexDirection: 'column', ...glass(true) }}
      >
        {/* Title bar — drag handle + URL bar. */}
        <div
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic/stale pointer */ }
            dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: card.x, originY: card.y };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            onMove(card.id, Math.max(4, drag.originX + event.clientX - drag.startX), Math.max(40, drag.originY + event.clientY - drag.startY));
          }}
          onPointerUp={() => { dragRef.current = null; setDragging(false); }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingTop: 7,
            paddingBottom: 7,
            paddingLeft: 12,
            paddingRight: 8,
            borderBottom: '1px solid var(--cnv-edge)',
            cursor: dragging ? 'grabbing' : 'grab',
            touchAction: 'none',
            userSelect: 'none',
          }}
        >
          <svg style={{ width: 11, height: 11, flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          <input
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              const next = normalizeUrl(urlDraft);
              if (next) {
                setUrlDraft(next);
                onNavigate(card.id, next);
              }
            }}
            onPointerDown={(event) => event.stopPropagation()}
            aria-label="Browser address"
            spellCheck={false}
            style={{
              flex: 1,
              borderWidth: 0,
              outline: 'none',
              background: 'var(--cnv-tint)',
              borderRadius: 8,
              paddingTop: 3,
              paddingBottom: 3,
              paddingLeft: 8,
              paddingRight: 8,
              color: 'var(--cnv-ink)',
              fontSize: 10.5,
              fontWeight: 300,
              letterSpacing: '-0.05px',
              fontFamily: FONT,
            }}
          />
          <button
            type="button"
            aria-label="Close browser"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onClose(card.id)}
            style={{
              borderWidth: 0,
              background: 'transparent',
              padding: 2,
              paddingLeft: 8,
              paddingRight: 8,
              fontSize: 11,
              color: 'var(--cnv-ink-muted)',
              cursor: 'pointer',
              fontFamily: FONT,
            }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            ✕
          </button>
        </div>

        {/* The page — solid paper behind the iframe, never glass-through. */}
        <div style={{ height: card.h, position: 'relative', background: '#fff' }}>
          <iframe
            key={card.url}
            src={card.url}
            title={`Browser — ${card.url}`}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', borderWidth: 0, ...(dragging || resizing ? { pointerEvents: 'none' } : {}) }}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />

          {/* Corner resize grip. */}
          <div
            role="presentation"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic/stale pointer */ }
              resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originW: card.w, originH: card.h };
              setResizing(true);
            }}
            onPointerMove={(event) => {
              const resize = resizeRef.current;
              if (!resize || resize.pointerId !== event.pointerId) return;
              onResize(
                card.id,
                Math.max(TERM_MIN_W, resize.originW + event.clientX - resize.startX),
                Math.max(TERM_MIN_H, resize.originH + event.clientY - resize.startY),
              );
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
              opacity: resizing ? 1 : 0.55,
            }}
            onMouseEnter={(event) => { event.currentTarget.style.opacity = '1'; }}
            onMouseLeave={(event) => { if (!resizeRef.current) event.currentTarget.style.opacity = '0.55'; }}
          >
            <svg width={9} height={9} viewBox="0 0 9 9" aria-hidden>
              <path d="M8 1 1 8M8 5 5 8" stroke="rgba(0,0,0,0.45)" strokeWidth="1.2" strokeLinecap="round" fill="none" />
            </svg>
          </div>
        </div>
      </SmoothCorners>
    </motion.div>
  );
}
