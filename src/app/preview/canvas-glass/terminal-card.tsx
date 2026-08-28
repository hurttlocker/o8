'use client';

/**
 * TerminalGlassCard — a REAL shell living on the canvas (#1232).
 *
 * Reuses the production terminal stack end-to-end: pty-backed sessions
 * over the desktop WebSocket, rendered by the same XtermPanel the
 * dashboard tabs use — so anything built here serves the default view
 * too. The card is the canvas treatment: glass frame (same recipe as
 * every other pane — transparent xterm over the card's tint + a tunable
 * dark veil for legibility); the GlassCardShell owns drag + resize +
 * focus + the close ✕. Close exits the shell (input "exit\n" then detach,
 * so the session dies instead of leaking into the dashboard's session list).
 */

import { memo, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { XtermPanel, type XtermPanelHandle } from '@/components/desktop/workspace-terminal/XtermPanel';
import { CANVAS_GLASS_CHANGED_EVENT } from '@/lib/canvas-mode/glass-settings';
import { CHROME, DEV_TERM_GLASS_TUNER, FONT, TERM_FONT_PX, TERM_MIN_H, TERM_MIN_W } from './ui';
import { GlassCardShell } from './card-shell';
import { useCanvasRenderProbe } from './perf/render-probe';

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
  /** Home agent (#1244): the local agent CLI command to auto-launch on first
   *  attach (claude | codex | gemini) — an all-local agent in the home dir
   *  (no repo / worktree / governance). Undefined for a plain terminal. */
  agentCli?: string;
}

// Rotating verbs in o8's own vocabulary while the
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
        fontSize: CHROME.bodySize,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        fontFamily: FONT,
      } as React.CSSProperties}
    >
      {SPAWN_VERBS[index]}…
    </motion.span>
  );
}

export const TerminalGlassCard = memo(function TerminalGlassCard({
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
  useCanvasRenderProbe('term', card.id);
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

  const titleLabel = card.exited
    ? 'Terminal — exited'
    : card.sessionName && card.live
      ? `Terminal — ${card.cwdLabel ?? card.sessionName.replace(/^cortex-dash-/, '').slice(0, 8)}`
      : 'Terminal';

  return (
    <GlassCardShell
      card={card}
      minW={TERM_MIN_W}
      minH={TERM_MIN_H}
      title={titleLabel}
      cornerHandles
      framed
      headerStyle="media"
      icon={(
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="4 17 10 11 4 5" /><line x1="12" x2="20" y1="19" y2="19" />
        </svg>
      )}
      onMove={onMove}
      onResize={onResize}
      onFocus={onFocus}
      onClose={() => onClose(card)}
    >
      {/* DEV ONLY — veil dial for the terminal glass legibility wash. Lives at
          the top of the body (not a ghost action button); freeze the chosen
          value into the default + flip DEV_TERM_GLASS_TUNER off to retire. */}
      {DEV_TERM_GLASS_TUNER ? (
        <div
          onPointerDown={(event) => event.stopPropagation()}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 5, paddingTop: 2, paddingBottom: 4, paddingLeft: 16, paddingRight: 16, flexShrink: 0 }}
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
        </div>
      ) : null}

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
              fontSize={TERM_FONT_PX}
              // 1.0 so xterm's DOM-renderer selection overlay lands on the glyph
              // baseline — 1.35 offsets the highlight ~½ line up under zoom (#1245).
              lineHeight={1.0}
              connectionEpoch={connectionEpoch}
              spawnReveal
              revealMinPlay={card.revealHold}
            />
          </div>
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <motion.span
              aria-hidden
              animate={{ rotate: 360 }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
              style={{ width: 14, height: 14, borderRadius: '50%', border: '1px solid transparent', borderTopColor: 'var(--cnv-ink)', borderRightColor: 'var(--cnv-edge)' }}
            />
            <ConnectingVerb />
          </div>
        )}
      </div>
    </GlassCardShell>
  );
});
