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

import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import { ThemeProvider } from '@/lib/theme/context';
import { O8SpecPane } from '@/components/desktop/o8-panel/O8SpecPane';
import { FONT, glass } from './ui';

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

export function SpecGlassCard({
  card,
  onMove,
  onResize,
  onFocus,
  onClose,
}: {
  card: SpecCard;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; originW: number; originH: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);

  const repoTail = card.repoPath ? card.repoPath.split('/').filter(Boolean).pop() ?? null : null;

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
        {/* Title bar — drag handle. */}
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
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span style={{ flex: 1, fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', fontFamily: FONT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            o8.md
            {repoTail ? <span style={{ color: 'var(--cnv-ink-muted)', fontWeight: 260 }}>{`  ·  ${repoTail}`}</span> : null}
          </span>
          <button
            type="button"
            aria-label="Close o8.md"
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

        {/* The REAL spec pane — FROSTED on the canvas (operator call,
            2026-06-12): the card rebinds the pane's --t-* surface tokens to
            the canvas glass vocabulary, so notes read as frost over the
            backdrop instead of dashboard paper. Same rebind mechanism the
            pane itself uses for its solid-surface ink. */}
        <div
          style={{
            height: card.h,
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
            ...(dragging || resizing ? { pointerEvents: 'none' } : {}),
          } as React.CSSProperties}
        >
          {/* No Ask-o8 scratch chat on the canvas (operator call 2026-06-12):
              the canvas composer IS the talk surface here; the popover was
              in the way. Dashboard keeps it. */}
          <ThemeProvider>
            <O8SpecPane repoPath={card.repoPath} />
          </ThemeProvider>

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
                Math.max(SPEC_MIN_W, resize.originW + event.clientX - resize.startX),
                Math.max(SPEC_MIN_H, resize.originH + event.clientY - resize.startY),
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
              pointerEvents: 'auto',
              zIndex: 2,
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
