'use client';

/**
 * Chat cards — a past orchestrator session as its OWN draggable glass box
 * (#1232). The right-side dock is reserved for the docked live
 * orchestrator; picking a session from history surfaces it here instead.
 * The dock glyph in the title bar promotes the card INTO the dock (adopts
 * the thread — the next message continues that conversation).
 */

import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import { DockEntryView } from './dock';
import { FONT, TONE_DOT, glass, type DockEntry } from './ui';

export interface ChatCard {
  id: number;
  threadId: string;
  repoPath: string | null;
  repoName: string | null;
  title: string;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  entries: DockEntry[];
}

const CHAT_MIN_W = 300;
const CHAT_MIN_H = 240;

export function ChatGlassCard({
  card,
  onMove,
  onResize,
  onFocus,
  onDock,
  onClose,
}: {
  card: ChatCard;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  /** Promote this conversation into the orchestrator dock (live line). */
  onDock: (card: ChatCard) => void;
  onClose: (id: number) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; originW: number; originH: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);

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
        {/* Title bar — drag handle, dock-it, close. */}
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
            paddingTop: 8,
            paddingBottom: 8,
            paddingLeft: 12,
            paddingRight: 8,
            borderBottom: '1px solid var(--cnv-edge)',
            cursor: dragging ? 'grabbing' : 'grab',
            touchAction: 'none',
            userSelect: 'none',
          }}
        >
          <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: TONE_DOT.idle, flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0 }}>
            <span style={{ fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', fontFamily: FONT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {card.title}
            </span>
            {card.repoName ? (
              <span style={{ fontSize: 9, fontWeight: 260, color: 'var(--cnv-ink-muted)', fontFamily: FONT }}>{card.repoName}</span>
            ) : null}
          </span>
          <button
            type="button"
            aria-label="Dock this conversation"
            title="Dock this conversation"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onDock(card)}
            style={{ borderWidth: 0, background: 'transparent', padding: 3, color: 'var(--cnv-ink-muted)', cursor: 'pointer', display: 'inline-flex' }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            <svg style={{ width: 12, height: 12, flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M15 3v18" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Close conversation"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onClose(card.id)}
            style={{
              borderWidth: 0,
              background: 'transparent',
              padding: 2,
              paddingLeft: 6,
              paddingRight: 6,
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

        {/* Transcript — same entry vocabulary the dock renders. */}
        <div
          style={{
            height: card.h,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            paddingTop: 12,
            paddingLeft: 14,
            paddingRight: 14,
            paddingBottom: 12,
            scrollbarWidth: 'none',
            position: 'relative',
          } as React.CSSProperties}
        >
          {card.entries.map((entry) => (
            <DockEntryView key={entry.id} entry={entry} />
          ))}
          {card.entries.length === 0 ? (
            <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--cnv-ink-muted)', lineHeight: 1.6, fontFamily: FONT }}>
              Nothing in this session yet.
            </span>
          ) : null}
        </div>

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
              Math.max(CHAT_MIN_W, resize.originW + event.clientX - resize.startX),
              Math.max(CHAT_MIN_H, resize.originH + event.clientY - resize.startY),
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
            zIndex: 2,
          }}
          onMouseEnter={(event) => { event.currentTarget.style.opacity = '1'; }}
          onMouseLeave={(event) => { if (!resizeRef.current) event.currentTarget.style.opacity = '0.55'; }}
        >
          <svg width={9} height={9} viewBox="0 0 9 9" aria-hidden>
            <path d="M8 1 1 8M8 5 5 8" stroke="var(--cnv-ink-muted)" strokeWidth="1.2" strokeLinecap="round" fill="none" />
          </svg>
        </div>
      </SmoothCorners>
    </motion.div>
  );
}
