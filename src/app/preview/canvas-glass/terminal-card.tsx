'use client';

/**
 * TerminalGlassCard — a REAL shell living on the canvas (#1232).
 *
 * Reuses the production terminal stack end-to-end: tmux-backed sessions
 * over the desktop WebSocket, rendered by the same XtermPanel the
 * dashboard tabs use — so anything built here serves the default view
 * too. The card is the canvas treatment: glass frame, title-bar drag,
 * close exits the shell (input "exit\n" then detach, so the tmux session
 * dies instead of leaking into the dashboard's session list).
 */

import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { XtermPanel, type XtermPanelHandle } from '@/components/desktop/workspace-terminal/XtermPanel';
import { FONT, TONE_DOT, glass } from './ui';

export interface TermCard {
  id: number;
  requestId: string;
  sessionName: string | null;
  exited: boolean;
  x: number;
  y: number;
}

export function TerminalGlassCard({
  card,
  onMove,
  onClose,
  registerHandle,
  sendTerminalAttach,
  sendTerminalInput,
  sendTerminalResize,
  sendTerminalDetach,
}: {
  card: TermCard;
  onMove: (id: number, x: number, y: number) => void;
  onClose: (card: TermCard) => void;
  registerHandle: (sessionName: string, handle: XtermPanelHandle | null) => void;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <motion.div
      initial={{ scale: 0.7, opacity: 0, y: 24 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={{ scale: 0.86, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 360, damping: 28 }}
      style={{
        position: 'absolute',
        left: card.x,
        top: card.y,
        width: 480,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 14,
        overflow: 'hidden',
        zIndex: 3,
        ...glass(true),
      }}
    >
      {/* Title bar — the drag handle. The body belongs to the shell. */}
      <div
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
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
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            flexShrink: 0,
            background: card.exited ? '#ef4444' : card.sessionName ? TONE_DOT.working : TONE_DOT.waiting,
          }}
        />
        <span style={{ flex: 1, fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', fontFamily: FONT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {card.exited ? 'Terminal — exited' : card.sessionName ? `Terminal — ${card.sessionName.replace(/^cortex-dash-/, '').slice(0, 8)}` : 'Terminal — connecting…'}
        </span>
        <button
          type="button"
          aria-label="Close terminal"
          onClick={() => onClose(card)}
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

      {/* The shell — the real XtermPanel, same one the dashboard mounts. */}
      <div style={{ height: 300, position: 'relative' }}>
        {card.sessionName ? (
          <XtermPanel
            key={card.sessionName}
            ref={(handle) => registerHandle(card.sessionName!, handle)}
            tmuxSession={card.sessionName}
            sendTerminalAttach={sendTerminalAttach}
            sendTerminalInput={sendTerminalInput}
            sendTerminalResize={sendTerminalResize}
            sendTerminalDetach={sendTerminalDetach}
            visible
          />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <motion.span
              aria-hidden
              animate={{ rotate: 360 }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
              style={{ width: 14, height: 14, borderRadius: '50%', border: '1px solid transparent', borderTopColor: 'var(--cnv-ink)', borderRightColor: 'var(--cnv-edge)' }}
            />
          </div>
        )}
      </div>
    </motion.div>
  );
}
