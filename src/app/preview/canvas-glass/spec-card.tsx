'use client';

/**
 * o8.md card — the operator's notes at FULL parity with the default-side
 * spec surface (#1232). Not a re-implementation: the card mounts the real
 * O8SpecPane (CodeMirror, CriticMarkup notes + orchestrator talk-back,
 * highlight colors, inline images, autosave) plus the Ask-o8 Brain
 * composer, inside the same glass shell the other cards use.
 *
 * ThemeProvider wraps the pane because the canvas route doesn't mount the
 * dashboard's provider — the pane's --t-* vocabulary resolves from the
 * operator's saved palette either way.
 */

import { memo } from 'react';
import { ThemeProvider } from '@/lib/theme/context';
import { O8SpecPane } from '@/components/desktop/o8-panel/O8SpecPane';
import { CHROME } from './ui';
import { GlassCardShell } from './card-shell';

export interface SpecCard {
  id: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  repoPath: string | null;
}

export const SPEC_MIN_W = 480;
export const SPEC_MIN_H = 380;

// The editor prose base in O8SpecEditor is `13.5px * var(--spec-scale)`.
const SPEC_PANE_BASE_PX = 13.5;

// The o8.md prose must read at the SAME on-screen size as every other canvas
// card's body (the shared CHROME.bodySize, e.g. a markdown or file card). The
// spec card renders OUT of the zoom layer (screenMap, for CodeMirror's caret) so
// it scales its own px by --spec-scale = s × SPEC_TEXT_BOOST (s = zoom); an
// in-layer card paints CHROME.bodySize under CSS zoom `s`. Matching on screen →
// 13.5 × SPEC_TEXT_BOOST === CHROME.bodySize. The old 1.27 boost rendered o8.md
// ~37% larger than every other card ("the o8.md panel text is a little bit
// bigger" — 2026-07-08); this pins it to the shared body scale. Agent handwriting
// notes keep their own knob (--o8ed-note-scale in O8SpecPane).
export const SPEC_TEXT_BOOST = CHROME.bodySize / SPEC_PANE_BASE_PX;

export const SpecGlassCard = memo(function SpecGlassCard({
  card,
  onMove,
  onResize,
  onFocus,
  onClose,
  screenMap,
}: {
  card: SpecCard;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
  /** Renders the card OUT of the zoom layer at true device-1:1 so CodeMirror's
   *  caret works (it breaks under any CSS scale in WebKit). The card's size +
   *  chrome + editor are scaled NUMERICALLY by the zoom instead, so it looks
   *  the same as an in-layer card. See GlassCardShell.screenMap + #1241. */
  screenMap?: { zoom: number; panX: number; panY: number } | null;
}) {
  const repoTail = card.repoPath ? card.repoPath.split('/').filter(Boolean).pop() ?? null : null;
  // Geometry scale for the pulled-out card (1 in-layer): drives the footprint
  // (width/height) + chrome so the card matches an in-layer card's size.
  const s = screenMap ? screenMap.zoom : 1;
  // Content scale = geometry × text boost, so the prose reads at the dock size
  // while the card stays the same footprint. In-layer (no screenMap) = 1.
  const specScale = screenMap ? s * SPEC_TEXT_BOOST : s;

  return (
    <GlassCardShell
      card={card}
      cornerHandles
      minW={SPEC_MIN_W}
      minH={SPEC_MIN_H}
      title="o8.md"
      badge={repoTail ?? undefined}
      onMove={onMove}
      onResize={onResize}
      onFocus={onFocus}
      onClose={onClose}
      screenMap={screenMap}
    >
      {/* The REAL spec pane — FROSTED on the canvas (operator call,
          2026-06-12): the card rebinds the pane's --t-* surface tokens to
          the canvas glass vocabulary, so notes read as frost over the
          backdrop instead of dashboard paper. Same rebind mechanism the
          pane itself uses for its solid-surface ink. */}
      <div
        style={{
          height: card.h * s,
          // --spec-scale: the editor renders at device 1:1 (no CSS scale, so
          // the caret hit-tests correctly) but multiplies its own px by this so
          // it LOOKS scaled like the rest of the canvas. Boosted above the
          // geometry scale so prose reads at the dock size (see SPEC_TEXT_BOOST).
          ['--spec-scale' as string]: specScale,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          ['--t-canvas-bg' as string]: 'transparent',
          ['--t-chat-surface-input-bg' as string]: 'rgba(255, 255, 255, 0.05)',
          ['--t-input-bg' as string]: 'rgba(255, 255, 255, 0.05)',
          ['--t-bg-subtle' as string]: 'rgba(255, 255, 255, 0.04)',
          ['--t-divider-subtle' as string]: 'var(--cnv-edge)',
          ['--t-chat-surface-text' as string]: 'var(--cnv-ink)',
          ['--t-chat-surface-text-secondary' as string]: 'var(--cnv-ink-muted)',
          ['--t-chat-surface-text-muted' as string]: 'var(--cnv-ink-muted)',
          ['--t-text' as string]: 'var(--cnv-ink)',
          ['--t-text-secondary' as string]: 'var(--cnv-ink-muted)',
          ['--t-text-muted' as string]: 'var(--cnv-ink-muted)',
          ['--t-text-faint' as string]: 'var(--cnv-ink-muted)',
        } as React.CSSProperties}
      >
        {/* No Ask-o8 scratch chat on the canvas (operator call 2026-06-12):
            the canvas composer IS the talk surface here; the popover was
            in the way. Dashboard keeps it. */}
        <ThemeProvider>
          {/* embedded: the GlassCardShell already is the card frame + header,
              so the pane drops its inner bordered editor box and fills the
              modal body directly — like the terminal card (operator call). */}
          <O8SpecPane repoPath={card.repoPath} embedded />
        </ThemeProvider>
      </div>
    </GlassCardShell>
  );
});
