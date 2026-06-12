'use client';

/**
 * TerminalGlassCard — a REAL shell living on the canvas (#1232).
 *
 * Reuses the production terminal stack end-to-end: pty-backed sessions
 * over the desktop WebSocket, rendered by the same XtermPanel the
 * dashboard tabs use — so anything built here serves the default view
 * too. The card is the canvas treatment: glass frame (same recipe as
 * every other pane — transparent xterm over the card's tint + a tunable
 * dark veil for legibility), title-bar drag, corner resize, click brings
 * it forward, close exits the shell (input "exit\n" then detach, so the
 * session dies instead of leaking into the dashboard's session list).
 */

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import { XtermPanel, type XtermPanelHandle } from '@/components/desktop/workspace-terminal/XtermPanel';
import { CANVAS_GLASS_CHANGED_EVENT } from '@/lib/canvas-mode/glass-settings';
import { DEV_TERM_GLASS_TUNER, FONT, TERM_MIN_H, TERM_MIN_W, TONE_DOT, glass } from './ui';

// NOTE: this module must export ONLY the component (+ types) — runtime
// const exports here would break the Fast Refresh boundary and remount
// live terminals on every edit. Constants belong in ui.ts. (Verified by
// editing this very comment with a live shell mounted.)

export interface TermCard {
  id: number;
  requestId: string;
  sessionName: string | null;
  exited: boolean;
  /** First PTY byte seen — flips the title from summoning verb to name. */
  live: boolean;
  /** First spawn of the visit: let the reveal's sweep + shimmer finish
   *  before the prompt paints (data held ~800ms max). */
  revealHold: boolean;
  x: number;
  y: number;
  /** Body (xterm area) size — the title bar adds its own height. */
  w: number;
  h: number;
  /** Stacking order — bumped by the page when the card takes focus. */
  z: number;
  /** Working directory the shell opens in (null = shell default, HOME). */
  cwd: string | null;
  cwdLabel: string | null;
}

// The Claude Code borrow — rotating verbs in o8's own vocabulary while the
// shell spawns, with one shimmer band sweeping the text (gradient-clip).
const SPAWN_VERBS = [
  'Summoning shell',
  'Warming the worktree',
  'Linking the lane',
  'Waking the fleet',
  'Polishing the glass',
  'Tracing packets',
  'Opening the dock',
  'Counting branches',
];

function ConnectingVerb() {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * SPAWN_VERBS.length));
  useEffect(() => {
    const timer = setInterval(() => setIndex((value) => (value + 1) % SPAWN_VERBS.length), 1100);
    return () => clearInterval(timer);
  }, []);
  return (
    <motion.span
      key={index}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, backgroundPosition: ['140% 0%', '-60% 0%'] }}
      transition={{
        opacity: { duration: 0.25 },
        backgroundPosition: { duration: 1.25, repeat: Infinity, ease: 'linear' },
      }}
      style={{
        backgroundImage: 'linear-gradient(90deg, rgba(255,255,255,0.38) 40%, rgba(255,255,255,0.98) 50%, rgba(255,255,255,0.38) 60%)',
        backgroundSize: '220% 100%',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
        fontSize: 11.5,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        fontFamily: FONT,
      } as React.CSSProperties}
    >
      {SPAWN_VERBS[index]}…
    </motion.span>
  );
}

export function TerminalGlassCard({
  card,
  termVeil,
  connectionEpoch,
  onMove,
  onResize,
  onFocus,
  onClose,
  onTermVeilChange,
  registerHandle,
  sendTerminalAttach,
  sendTerminalInput,
  sendTerminalResize,
  sendTerminalDetach,
}: {
  card: TermCard;
  /** Dark wash painted behind the transparent xterm (legibility dial). */
  termVeil: number;
  /** WS connect counter — XtermPanel re-attaches on each bump (self-heal). */
  connectionEpoch: number;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  onClose: (card: TermCard) => void;
  onTermVeilChange: (value: number) => void;
  registerHandle: (sessionName: string, handle: XtermPanelHandle | null) => void;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; originW: number; originH: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);

  // The shell inks with the CANVAS vocabulary — one text color across the
  // whole theme (Q, 2026-06-12). buildXtermTheme reads --t-terminal-* off
  // the root, which the o8.md card's ThemeProvider stamps with dashboard
  // palette values; this override keeps canvas terminals on --cnv-ink.
  const [inkOverrides, setInkOverrides] = useState<Record<string, string> | undefined>(undefined);
  useEffect(() => {
    const read = () => {
      const styles = getComputedStyle(document.documentElement);
      const ink = styles.getPropertyValue('--cnv-ink').trim();
      if (ink) setInkOverrides({ foreground: ink, cursor: ink, selectionForeground: ink });
    };
    read();
    // The tuner fires the event per slider input tick — rAF-coalesce so N
    // open terminals don't each force a style read at drag frequency.
    let frame = 0;
    const onGlassChange = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; read(); });
    };
    window.addEventListener(CANVAS_GLASS_CHANGED_EVENT, onGlassChange);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener(CANVAS_GLASS_CHANGED_EVENT, onGlassChange);
    };
  }, []);

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
      {/* Visual shell — Apple-smooth squircle corners (Lisse). The motion
          div above owns geometry + springs; this owns glass + clip. */}
      <SmoothCorners
        corners={{ radius: 14 }}
        shadowStrategy="box-shadow"
        style={{ display: 'flex', flexDirection: 'column', ...glass(true) }}
      >
      {/* Title bar — the drag handle. The body belongs to the shell. */}
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
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            flexShrink: 0,
            background: card.exited ? '#ef4444' : card.sessionName && card.live ? TONE_DOT.working : TONE_DOT.waiting,
          }}
        />
        <span style={{ flex: 1, fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', fontFamily: FONT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {card.exited
            ? 'Terminal — exited'
            : card.sessionName && card.live
              ? `Terminal — ${card.cwdLabel ?? card.sessionName.replace(/^cortex-dash-/, '').slice(0, 8)}`
              : <ConnectingVerb />}
        </span>
        {DEV_TERM_GLASS_TUNER ? (
          <span
            onPointerDown={(event) => event.stopPropagation()}
            style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}
          >
            <input
              type="range"
              aria-label="Terminal veil (dev)"
              min={0}
              max={0.85}
              step={0.01}
              value={termVeil}
              onChange={(event) => {
                const next = Number.parseFloat(event.target.value);
                if (Number.isFinite(next)) onTermVeilChange(next);
              }}
              style={{ width: 54, accentColor: '#f59e0b', cursor: 'pointer' }}
            />
            <span style={{ fontSize: 9, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontVariantNumeric: 'tabular-nums', fontFamily: FONT, width: 24 }}>
              {Math.round(termVeil * 100)}%
            </span>
          </span>
        ) : null}
        <button
          type="button"
          aria-label="Close terminal"
          onPointerDown={(event) => event.stopPropagation()}
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

      {/* The shell — the real XtermPanel, same one the dashboard mounts.
          Transparent over the card glass; the veil restores legibility.
          --t-terminal-bg: our xterm.css paints .xterm/.xterm-screen/viewport
          with this var (fallback #16191e) — undefined on the canvas route,
          so without this override the fallback renders an opaque slab. */}
      <div style={{ height: card.h, position: 'relative', ...({ '--t-terminal-bg': 'transparent' } as React.CSSProperties) }}>
        <div aria-hidden style={{ position: 'absolute', inset: 0, background: `rgba(7, 9, 13, ${termVeil.toFixed(2)})` }} />
        {card.sessionName ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', paddingTop: 6, paddingLeft: 10, paddingRight: 4, paddingBottom: 4 }}>
            <XtermPanel
              key={card.sessionName}
              ref={(handle) => registerHandle(card.sessionName!, handle)}
              tmuxSession={card.sessionName}
              sendTerminalAttach={sendTerminalAttach}
              sendTerminalInput={sendTerminalInput}
              sendTerminalResize={sendTerminalResize}
              sendTerminalDetach={sendTerminalDetach}
              visible
              transparent
              themeOverrides={inkOverrides}
              fontSize={11.5}
              connectionEpoch={connectionEpoch}
              spawnReveal
              revealMinPlay={card.revealHold}
            />
          </div>
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

        {/* Corner resize grip — XtermPanel's ResizeObserver refits the PTY. */}
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
            <path d="M8 1 1 8M8 5 5 8" stroke="var(--cnv-ink-muted)" strokeWidth="1.2" strokeLinecap="round" fill="none" />
          </svg>
        </div>
      </div>
      </SmoothCorners>
    </motion.div>
  );
}
