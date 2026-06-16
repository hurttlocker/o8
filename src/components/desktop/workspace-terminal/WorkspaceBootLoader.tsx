'use client';

/**
 * WorkspaceBootLoader — the calm boot loader shown while a workspace
 * surface is resolving: OrchestratorTab rehydrating its last thread, or
 * the workspace panel still figuring out its tabs (the boot window before
 * the "Start a new session" CTA is allowed to show).
 *
 * The "o8" glyph + warm orange diagonal sweep is the DOM twin of the
 * canvas terminals' xterm spawn-reveal (`spawn-reveal.ts`) — same MARK
 * block-art, same one-orange leading edge settling to a faint grey — so
 * the boot identity reads the same on the dashboard as it does in a
 * terminal. Pure DOM + inline styles (no xterm), and theme-safe: the
 * settled blocks use a faint ink token while the sweep crest uses the
 * brand orange, which reads on both light and dark surfaces (a white
 * crest would vanish on light paper).
 */

import { memo } from 'react';
import { createPortal } from 'react-dom';

// "o8" in five rows of block-art, lifted verbatim from spawn-reveal.ts's
// MARK so the dashboard loader and the terminal loader paint the same glyph.
const O8_MARK = [
  ' ████   ████ ',
  '██  ██ ██  ██',
  '██  ██  ████ ',
  '██  ██ ██  ██',
  ' ████   ████ ',
];

const CELL = 9; // px per block
const GAP = 2; // px between blocks

function WorkspaceBootLoaderBase() {
  // Portal to <body> as a FIXED, viewport-centered splash. The loader used to
  // live in-flow inside the workspace card, so the glyph "jumped": the center
  // card renders full-width, then the right panel mounts late and the card
  // reflows to a narrow column — dragging the centered glyph with it. Worse,
  // the card carries a Lisse clip-path (squircle corners) which is a
  // containing block for position:fixed, so a plain fixed element would be
  // trapped + clipped. Portaling escapes that and pins the glyph dead-center
  // over the workspace's own paper surface, masking the panel-settle churn
  // until the real UI is ready. Fades in so a sub-200ms rehydration barely
  // shows it.
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 180,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        background: 'var(--t-chat-surface-bg)',
        animation: 'o8BootBackdropIn 200ms ease-out both',
      }}
      aria-label="Loading workspace"
      aria-live="polite"
    >
      <style>{`
        @keyframes o8BootBackdropIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        /* The sweep drives OPACITY (GPU-composited) instead of
           background-color (a main-thread paint property). On a page reload
           the main thread is slammed hydrating the dashboard; a color
           animation can't repaint and FREEZES on an early frame (the
           "static old loader"). An opacity animation runs on the compositor,
           so the glow keeps moving even while the main thread is blocked. */
        @keyframes o8MarkGlow {
          0%, 30%, 100% { opacity: 0; }
          12%           { opacity: 1; }
          20%           { opacity: 0.72; }
        }
        @keyframes o8BootFadeIn {
          from { opacity: 0; transform: translateY(2px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 14,
          animation: 'o8BootFadeIn 280ms ease-out both',
        }}
      >
        <div
          aria-hidden
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${O8_MARK[0].length}, ${CELL}px)`,
            gridAutoRows: `${CELL}px`,
            gap: GAP,
          }}
        >
          {O8_MARK.flatMap((row, r) =>
            row.split('').map((ch, c) =>
              ch === '█' ? (
                <div
                  key={`${r}-${c}`}
                  style={{
                    position: 'relative',
                    width: CELL,
                    height: CELL,
                    borderRadius: 1.5,
                    background: 'var(--t-text-faint)',
                  }}
                >
                  {/* Orange crest as an opacity-animated overlay (composited),
                      staggered along (col + 0.45·row) so it wipes left-to-right
                      with the same downward skew as the terminal spawn-reveal. */}
                  <span
                    aria-hidden
                    style={{
                      position: 'absolute',
                      inset: 0,
                      borderRadius: 1.5,
                      background: 'rgb(251, 191, 36)',
                      opacity: 0,
                      willChange: 'opacity',
                      animation: 'o8MarkGlow 2s ease-in-out infinite',
                      animationDelay: `${(c + r * 0.45) * 0.06}s`,
                    }}
                  />
                </div>
              ) : (
                <div key={`${r}-${c}`} style={{ width: CELL, height: CELL }} />
              ),
            ),
          )}
        </div>
        <div
          style={{
            fontSize: 11.5,
            fontWeight: 320,
            letterSpacing: '0.01em',
            color: 'var(--t-text-faint)',
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          Loading workspace…
        </div>
      </div>
    </div>,
    document.body,
  );
}

export const WorkspaceBootLoader = memo(WorkspaceBootLoaderBase);
