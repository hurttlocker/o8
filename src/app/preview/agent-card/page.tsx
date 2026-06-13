'use client';

/**
 * Test bench for the smooth agent card (#1232 polish pass, 2026-06-13).
 *
 * Q's reference: a glass card with two tabs ("Agentic | Chat History" →
 * here "Orchestrator | Cortex") and an agent response rendered SMOOTH —
 * no underline under the tabs, no divider lines, no boxes around results.
 * Reasoning label, then a result that's just thumbnail + bold title +
 * wrapped description flowing on the glass. Resize from all 8 angles with
 * the handles hidden (native-window feel).
 *
 * This page is the isolation bench: nail the feel here, then port the
 * locked treatment into dock.tsx + chat-card.tsx + the shared entry view.
 */

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import { applyCanvasGlassSettings, CANVAS_GLASS_DEFAULTS } from '@/lib/canvas-mode/glass-settings';
import { FONT } from '../canvas-glass/ui';

const MIN_W = 320;
const MIN_H = 240;

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Invisible resize zones — 8 of them, hugging the card's edges/corners.
 *  Edges are thin strips; corners are small squares with higher priority. */
const ZONES: Array<{ key: Edge; cursor: string; style: React.CSSProperties }> = [
  { key: 'n', cursor: 'ns-resize', style: { top: -5, left: 14, right: 14, height: 10 } },
  { key: 's', cursor: 'ns-resize', style: { bottom: -5, left: 14, right: 14, height: 10 } },
  { key: 'e', cursor: 'ew-resize', style: { top: 14, bottom: 14, right: -5, width: 10 } },
  { key: 'w', cursor: 'ew-resize', style: { top: 14, bottom: 14, left: -5, width: 10 } },
  { key: 'ne', cursor: 'nesw-resize', style: { top: -6, right: -6, width: 18, height: 18 } },
  { key: 'nw', cursor: 'nwse-resize', style: { top: -6, left: -6, width: 18, height: 18 } },
  { key: 'se', cursor: 'nwse-resize', style: { bottom: -6, right: -6, width: 18, height: 18 } },
  { key: 'sw', cursor: 'nesw-resize', style: { bottom: -6, left: -6, width: 18, height: 18 } },
];

interface Geom { x: number; y: number; w: number; h: number; }

function resizeGeom(edge: Edge, dx: number, dy: number, start: Geom): Geom {
  let { x, y, w, h } = start;
  if (edge.includes('e')) w = start.w + dx;
  if (edge.includes('s')) h = start.h + dy;
  if (edge.includes('w')) { w = start.w - dx; x = start.x + dx; }
  if (edge.includes('n')) { h = start.h - dy; y = start.y + dy; }
  // Clamp to the floor; when grabbing the top/left edge, freeze x/y once the
  // floor is hit so the opposite edge stays put.
  if (w < MIN_W) { if (edge.includes('w')) x -= MIN_W - w; w = MIN_W; }
  if (h < MIN_H) { if (edge.includes('n')) y -= MIN_H - h; h = MIN_H; }
  return { x, y, w, h };
}

export default function AgentCardBench() {
  const [tab, setTab] = useState<'orchestrator' | 'cortex'>('orchestrator');
  const [inTauri, setInTauri] = useState(false);
  const [geom, setGeom] = useState<Geom>({ x: 320, y: 130, w: 460, h: 380 });
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);

  const dragRef = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const resizeRef = useRef<{ id: number; edge: Edge; sx: number; sy: number; start: Geom } | null>(null);

  useEffect(() => {
    applyCanvasGlassSettings(CANVAS_GLASS_DEFAULTS);
    setInTauri(typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window);
  }, []);

  const onDragDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic */ }
    dragRef.current = { id: event.pointerId, sx: event.clientX, sy: event.clientY, ox: geom.x, oy: geom.y };
    setDragging(true);
  };
  const onDragMove = (event: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.id !== event.pointerId) return;
    setGeom((g) => ({ ...g, x: Math.max(8, d.ox + (event.clientX - d.sx)), y: Math.max(8, d.oy + (event.clientY - d.sy)) }));
  };
  const onDragUp = () => { dragRef.current = null; setDragging(false); };

  const onResizeDown = (edge: Edge) => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic */ }
    resizeRef.current = { id: event.pointerId, edge, sx: event.clientX, sy: event.clientY, start: geom };
    setResizing(true);
  };
  const onResizeMove = (event: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r || r.id !== event.pointerId) return;
    setGeom(resizeGeom(r.edge, event.clientX - r.sx, event.clientY - r.sy, r.start));
  };
  const onResizeUp = () => { resizeRef.current = null; setResizing(false); };

  const locked = dragging || resizing;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'hidden',
        fontFamily: FONT,
        background: inTauri ? 'transparent' : '#0a0c10',
        userSelect: 'none',
      }}
    >
      {/* Canvas veil + dot field — same backdrop the real canvas paints, so
          the glass reads the way it will in the app. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'var(--cnv-bg-veil)',
          backgroundImage: 'radial-gradient(circle, var(--cnv-bg-dot, rgba(255,255,255,0.055)) 1px, transparent 1.4px)',
          backgroundSize: '26px 26px',
        }}
      />

      {/* A caption so the bench is self-describing. */}
      <div style={{ position: 'absolute', top: 18, left: 22, zIndex: 1, fontSize: 11, fontWeight: 300, letterSpacing: '0.04em', color: 'var(--cnv-ink-muted)' }}>
        agent-card bench · drag the header · resize from any edge or corner
      </div>

      {/* The card. */}
      <motion.div
        initial={{ scale: 0.94, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 320, damping: 30 }}
        style={{ position: 'absolute', left: geom.x, top: geom.y, width: geom.w, height: geom.h, zIndex: 2 }}
      >
        <SmoothCorners
          corners={{ radius: 22 }}
          shadowStrategy="box-shadow"
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            background: 'var(--cnv-chat-tint, var(--cnv-tint-deep))',
            backdropFilter: locked ? 'none' : 'blur(var(--cnv-chat-frost, var(--cnv-frost))) saturate(var(--cnv-sat, 1.6))',
            WebkitBackdropFilter: locked ? 'none' : 'blur(var(--cnv-chat-frost, var(--cnv-frost))) saturate(var(--cnv-sat, 1.6))',
            color: 'var(--cnv-ink)',
            boxShadow: '0 24px 70px rgba(0, 0, 0, 0.42)',
          } as React.CSSProperties}
        >
          {/* Tabs = the only chrome. No underline, no divider — the active tab
              is a weight + ink shift only. The strip is the drag handle. */}
          <div
            onPointerDown={onDragDown}
            onPointerMove={onDragMove}
            onPointerUp={onDragUp}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-around',
              paddingTop: 17,
              paddingBottom: 15,
              paddingLeft: 20,
              paddingRight: 20,
              cursor: dragging ? 'grabbing' : 'grab',
              touchAction: 'none',
              flexShrink: 0,
            }}
          >
            <SmoothTab label="Orchestrator" active={tab === 'orchestrator'} onClick={() => setTab('orchestrator')} />
            <SmoothTab label="Cortex" active={tab === 'cortex'} onClick={() => setTab('cortex')} />
          </div>

          {/* Response body — everything flows on the glass, no boxes. */}
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 18,
              paddingLeft: 24,
              paddingRight: 24,
              paddingTop: 4,
              paddingBottom: 24,
              scrollbarWidth: 'none',
              ...(locked ? { pointerEvents: 'none' } : {}),
            } as React.CSSProperties}
          >
            {tab === 'orchestrator' ? <SampleResponse /> : <SampleCortex />}
          </div>
        </SmoothCorners>

        {/* Invisible resize zones — hidden handles, all 8 angles. */}
        {ZONES.map((z) => (
          <div
            key={z.key}
            role="presentation"
            onPointerDown={onResizeDown(z.key)}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            style={{ position: 'absolute', cursor: z.cursor, touchAction: 'none', zIndex: z.key.length === 2 ? 4 : 3, ...z.style }}
          />
        ))}
      </motion.div>
    </div>
  );
}

/** Smooth tab — weight + ink shift, no underline, no box. */
function SmoothTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
      style={{
        borderWidth: 0,
        background: 'transparent',
        padding: 0,
        cursor: 'pointer',
        fontFamily: FONT,
        fontSize: 14,
        fontWeight: active ? 500 : 400,
        letterSpacing: '-0.2px',
        color: active ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
        opacity: active ? 1 : 0.7,
        transition: 'color 160ms ease, opacity 160ms ease',
      }}
      onMouseEnter={(event) => { if (!active) event.currentTarget.style.opacity = '1'; }}
      onMouseLeave={(event) => { if (!active) event.currentTarget.style.opacity = '0.7'; }}
    >
      {label}
    </button>
  );
}

/** A sample agent response — reasoning label, then a borderless result
 *  (thumbnail + bold title + wrapped description), then a closing line. */
function SampleResponse() {
  return (
    <>
      <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.11em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', paddingTop: 6 }}>
        Reasoning · 1:34 min
      </span>

      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <div
          aria-hidden
          style={{
            width: 64,
            height: 64,
            borderRadius: 13,
            flexShrink: 0,
            background: 'linear-gradient(140deg, #b5a37c 0%, #7c6b4a 45%, #3c3322 100%)',
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.2px', color: 'var(--cnv-ink)', lineHeight: 1.3 }}>
            Desert Weaver Beneath the Tree
          </span>
          <span style={{ fontSize: 12.5, fontWeight: 300, lineHeight: 1.55, color: 'var(--cnv-ink-muted)' }}>
            A sepia-toned scene shows a person sitting on the ground beneath a large, leaning tree, operating a simple loom-like structure made from wood and hanging threads. The figure appears as a dark silhouette while working with the threads, surrounded by a dry, natural landscape.
          </span>
        </div>
      </div>

      <span style={{ fontSize: 12.5, fontWeight: 300, lineHeight: 1.65, color: 'var(--cnv-ink)' }}>
        Done — the composition reads as a quiet, focused craft moment. Want me to push a higher-contrast variant or keep this palette?
      </span>
    </>
  );
}

/** Cortex side — a sample cited Brain answer, equally smooth. */
function SampleCortex() {
  return (
    <>
      <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.11em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', paddingTop: 6 }}>
        Reading 7 sources
      </span>
      <span style={{ fontSize: 12.5, fontWeight: 300, lineHeight: 1.65, color: 'var(--cnv-ink)' }}>
        The dock is a pinned right-edge panel; the floating role belongs to the chat-card modal. Every orchestrator surface carries the Orchestrator | Cortex split, defaulting to Orchestrator.
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {['canvas-orchestrator-brain-pane', 'orchestrator-tab-architecture', 'o8 CLAUDE.md'].map((title) => (
          <span key={title} style={{ fontSize: 9.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', opacity: 0.85 }}>
            {`· ${title}`}
          </span>
        ))}
      </div>
    </>
  );
}
