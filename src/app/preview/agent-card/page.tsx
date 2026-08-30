'use client';

/**
 * Test bench for the smooth agent card (#1232 polish pass, 2026-06-13).
 *
 * Q's reference: a glass card with a grab pill, two tabs ("Agentic | Chat
 * History" → here "Orchestrator | Cortex") and an agent response rendered
 * SMOOTH — no underline under the tabs, no divider lines, no boxes around
 * results. Reasoning label, a result that's just thumbnail + bold title +
 * wrapped description, then a staged reasoning timeline (dashed connectors,
 * time chips, titles, bodies). A compact composer (canvas-composer style,
 * smaller) lives under each card; its textarea grows with content
 * (`field-sizing: content`) instead of nested-scrolling. Resize from all 8
 * angles with the handles hidden.
 *
 * This page is the isolation bench: nail the feel here, then port the
 * locked treatment into dock.tsx + chat-card.tsx + the shared entry view.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { motion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import { applyCanvasGlassSettings, CANVAS_GLASS_DEFAULTS } from '@/lib/canvas-mode/glass-settings';
import { FONT } from '../canvas-glass/ui';

const MIN_W = 320;
const MIN_H = 260;

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

const subscribeToStaticEnvironment = () => () => {};
const readTauriEnvironment = () => '__TAURI_INTERNALS__' in window;

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
  const inTauri = useSyncExternalStore(subscribeToStaticEnvironment, readTauriEnvironment, () => false);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    applyCanvasGlassSettings(CANVAS_GLASS_DEFAULTS);
  }, []);

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

      {/* Caption + a toggle to flip the orchestrator turn between settled and
          live-working (so both states are screenshot-able on the bench). */}
      <div style={{ position: 'absolute', top: 16, left: 22, zIndex: 1, display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ fontSize: 11, fontWeight: 300, letterSpacing: '0.04em', color: 'var(--cnv-ink-muted)' }}>
          agent-card bench · drag the grab pill · resize from any edge or corner
        </span>
        <button
          type="button"
          onClick={() => setWorking((value) => !value)}
          style={{ borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--cnv-edge)', background: 'var(--cnv-tint)', borderRadius: 999, paddingTop: 3, paddingBottom: 3, paddingLeft: 11, paddingRight: 11, fontSize: 10.5, fontWeight: 400, color: 'var(--cnv-ink)', cursor: 'pointer', fontFamily: FONT }}
        >
          {working ? '● working' : '○ settled'}
        </button>
      </div>

      {/* The card — Current surface (softer, tone-adaptive — Q's pick), with a
          lighter shadow. Drag the grab pill, resize from any edge or corner. */}
      <AgentCard initial={{ x: 470, y: 116, w: 452, h: 452 }} tab={tab} setTab={setTab} working={working} />
    </div>
  );
}

/** One agent card — owns its geometry, drag, and 8-angle resize. The
 *  `presence` prop is the only visual difference across the side-by-side pair:
 *  'current' = the tone-adaptive surface; 'boosted' = an extra tint layer +
 *  hairline edge + inner highlight + deeper shadow so it holds on light. */
function AgentCard({ initial, tab, setTab, working }: {
  initial: Geom;
  tab: 'orchestrator' | 'cortex';
  setTab: (value: 'orchestrator' | 'cortex') => void;
  working: boolean;
}) {
  const [geom, setGeom] = useState<Geom>(initial);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const resizeRef = useRef<{ id: number; edge: Edge; sx: number; sy: number; start: Geom } | null>(null);

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
            boxShadow: '0 14px 42px rgba(0, 0, 0, 0.24)',
          } as React.CSSProperties}
        >
          {/* Header = grab pill + tabs. The only chrome: no underline, no
              divider. Active tab is a weight + ink shift. The whole header
              drags (the pill is the visible affordance). */}
          <div
            onPointerDown={onDragDown}
            onPointerMove={onDragMove}
            onPointerUp={onDragUp}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'stretch',
              paddingTop: 9,
              cursor: dragging ? 'grabbing' : 'grab',
              touchAction: 'none',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 8 }}>
              <span aria-hidden style={{ width: 34, height: 4, borderRadius: 3, background: 'var(--cnv-ink-muted)', opacity: 0.35 }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-around', paddingLeft: 20, paddingRight: 20, paddingBottom: 13 }}>
              <SmoothTab label="Orchestrator" active={tab === 'orchestrator'} onClick={() => setTab('orchestrator')} />
              <SmoothTab label="Cortex" active={tab === 'cortex'} onClick={() => setTab('cortex')} />
            </div>
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
              paddingLeft: 22,
              paddingRight: 22,
              paddingTop: 2,
              paddingBottom: 18,
              scrollbarWidth: 'none',
              ...(locked ? { pointerEvents: 'none' } : {}),
            } as React.CSSProperties}
          >
            {tab === 'orchestrator' ? (working ? <WorkingResponse /> : <SampleResponse />) : <SampleCortex />}
          </div>

          {/* Compact composer — canvas-composer style, smaller. */}
          <CompactComposer working={tab === 'orchestrator' && working} />
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

/** A sample agent response — a true o8 moment: the orchestrator reviewing
 *  its own pinned-dock change with a screenshot it captured, then the
 *  staged reasoning timeline. All borderless on the glass. */
function SampleResponse() {
  return (
    <>
      <UserMessage text="Review the pinned dock and ship it if it's clean." />

      <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.11em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', paddingTop: 2 }}>
        Reasoning · 1:12 min
      </span>

      {/* The captured screenshot the orchestrator reviewed — image-led result,
          borderless, faint hover to open. */}
      <ResultRow onOpen={() => {}}>
        <ScreenshotThumb />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.2px', color: 'var(--cnv-ink)', lineHeight: 1.3 }}>
            Reviewed the pinned dock on the live app
          </span>
          <span style={{ fontSize: 12.5, fontWeight: 300, lineHeight: 1.55, color: 'var(--cnv-ink-muted)' }}>
            Captured the running canvas to check the dock against the reference — right-edge berth, the Orchestrator | Cortex strip reads borderless, no divider lines.
          </span>
        </div>
      </ResultRow>

      {/* Reasoning timeline — staged, dashed connectors, time + title + body. */}
      <ReasoningTimeline stages={STAGES} />

      {/* Concrete outputs — same borderless result shape, icon-led. */}
      <EditedFilesResult />
      <PrResult />
    </>
  );
}

/** Live working turn — the agent mid-flight: ticking reasoning header with
 *  the orbit, the settled stages so far, then a shimmering tool-activity
 *  line. No result yet — it's still working. */
function WorkingResponse() {
  return (
    <>
      <UserMessage text="Add the live working state — show the agent actually working." />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 2 }}>
        <motion.span
          aria-hidden
          animate={{ rotate: 360 }}
          transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
          style={{ width: 10, height: 10, borderRadius: '50%', borderWidth: 1.5, borderStyle: 'solid', borderColor: 'transparent', borderTopColor: 'var(--cnv-ink)', borderRightColor: 'var(--cnv-edge)', flexShrink: 0 }}
        />
        <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.11em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)' }}>
          Reasoning · 0:38 min
        </span>
      </div>

      <ReasoningTimeline stages={WORKING_STAGES} />

      {/* Live tool-activity — one shimmering row for the current work phase. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--cnv-ink)', flexShrink: 0 }} />
        <motion.span
          animate={{ opacity: [0.45, 0.95, 0.45] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
          style={{ fontSize: 12.5, fontWeight: 300, color: 'var(--cnv-ink)' }}
        >
          Editing chat-card.tsx
          <span style={{ color: 'var(--cnv-ink-muted)' }}>{' · 3 files'}</span>
        </motion.span>
      </div>
    </>
  );
}

const STAGES = [
  { time: '0:21 min', title: 'Scoped the change', body: 'Read dock.tsx and chat-card.tsx to map the floating-vs-pinned split before touching either surface.' },
  { time: '0:40 min', title: 'Verified the geometry', body: 'Drove the live app and checked the dock against the reference — pinned right-edge berth, the tab strip with no underline, the response flowing on the glass.' },
  { time: '0:11 min', title: 'Confirmed clean', body: 'Typecheck, lint, and the 89-test suite all green; committed and pushed, ready to port.' },
];

const WORKING_STAGES = [
  { time: '0:14 min', title: 'Read the bench', body: 'Mapped the card — header, response body, composer — before threading the live state through.' },
  { time: '0:24 min', title: 'Wiring the working view', body: 'Streaming the reasoning header with the orbit, then a shimmering tool line under the settled stages.' },
];

/** The model's thinking as a staged timeline — dashed spine, time chips,
 *  stage titles, muted bodies. Matches the reference's lower section. */
function ReasoningTimeline({ stages }: { stages: Array<{ time: string; title: string; body: string }> }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {stages.map((stage, index) => {
        const last = index === stages.length - 1;
        return (
          <div key={stage.title} style={{ display: 'flex', gap: 11 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 6, flexShrink: 0, paddingTop: 5 }}>
              <span aria-hidden style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--cnv-ink-muted)', flexShrink: 0 }} />
              {!last ? <span aria-hidden style={{ flex: 1, width: 0, marginTop: 3, marginBottom: 1, borderLeft: '1px dashed var(--cnv-edge)' } as React.CSSProperties} /> : null}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingBottom: last ? 0 : 16, minWidth: 0 }}>
              <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', opacity: 0.85, fontVariantNumeric: 'tabular-nums' }}>
                {stage.time}
              </span>
              <span style={{ fontSize: 12.5, fontWeight: 500, letterSpacing: '-0.15px', color: 'var(--cnv-ink)' }}>
                {stage.title}
              </span>
              <span style={{ fontSize: 12, fontWeight: 300, lineHeight: 1.55, color: 'var(--cnv-ink-muted)' }}>
                {stage.body}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A faux app screenshot — what the orchestrator captured to review. Fixed
 *  dark UI (it depicts an image, not a theme surface), title bar + sidebar +
 *  content lines so it reads as a real capture at thumbnail size. */
function ScreenshotThumb() {
  return (
    <div style={{ width: 92, height: 66, borderRadius: 11, overflow: 'hidden', flexShrink: 0, background: 'linear-gradient(160deg, #2b303b 0%, #14171d 100%)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 13, display: 'flex', alignItems: 'center', gap: 3, paddingLeft: 6, background: 'rgba(255,255,255,0.05)' }}>
        <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'rgba(255,255,255,0.28)' }} />
        <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'rgba(255,255,255,0.18)' }} />
        <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'rgba(255,255,255,0.12)' }} />
      </div>
      <div style={{ flex: 1, display: 'flex', gap: 5, paddingTop: 6, paddingBottom: 6, paddingLeft: 6, paddingRight: 8 }}>
        <div style={{ width: 16, background: 'rgba(255,255,255,0.06)', borderRadius: 3, flexShrink: 0 }} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 2 }}>
          <div style={{ height: 5, width: '64%', background: 'rgba(255,255,255,0.12)', borderRadius: 2 }} />
          <div style={{ height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 2 }} />
          <div style={{ height: 5, width: '84%', background: 'rgba(255,255,255,0.06)', borderRadius: 2 }} />
        </div>
      </div>
    </div>
  );
}

const SOURCES: Array<{ kind: string; title: string }> = [
  { kind: 'memory', title: 'canvas-orchestrator-brain-pane' },
  { kind: 'spec', title: 'o8 CLAUDE.md — Orchestrator Architecture' },
  { kind: 'pr', title: '#374945e2 · pinned dock + split-tab modals' },
  { kind: 'outcome', title: 'session: dock revert to pinned' },
];

/** A result row — borderless at rest, a faint tint on hover to afford the
 *  click (open the PR, the diff, the file set). The leading visual + title +
 *  meta shape comes straight from the reference's result block. */
function ResultRow({ children, onOpen }: { children: React.ReactNode; onOpen?: () => void }) {
  return (
    <div
      onClick={onOpen}
      style={{ display: 'flex', gap: 13, alignItems: 'flex-start', borderRadius: 12, paddingTop: 8, paddingBottom: 8, paddingLeft: 8, paddingRight: 8, marginLeft: -8, marginRight: -8, cursor: onOpen ? 'pointer' : 'default', transition: 'background 140ms ease' }}
      onMouseEnter={(event) => { if (onOpen) event.currentTarget.style.background = 'var(--cnv-tint)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </div>
  );
}

/** Leading icon tile — the borderless analog of the screenshot thumbnail for
 *  icon-style results (edits, PRs). */
function ResultTile({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <span style={{ width: 40, height: 40, borderRadius: 11, background: 'var(--cnv-tint)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: tone ?? 'var(--cnv-ink-muted)' }}>
      {children}
    </span>
  );
}

/** Borderless text action (Review / Undo) — a soft tint chip. */
function ActionChip({ label }: { label: string }) {
  return (
    <button
      type="button"
      onClick={(event) => event.stopPropagation()}
      style={{ borderWidth: 0, background: 'var(--cnv-tint)', borderRadius: 7, paddingTop: 3, paddingBottom: 3, paddingLeft: 9, paddingRight: 9, fontSize: 11, fontWeight: 400, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', cursor: 'pointer', fontFamily: FONT }}
    >
      {label}
    </button>
  );
}

/** Diff stats — semantic +adds (green) / −dels (red). */
function DiffStat({ adds, dels }: { adds: number; dels: number }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 400, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.1px', whiteSpace: 'nowrap' }}>
      <span style={{ color: '#3fb950' }}>{`+${adds}`}</span>
      <span>{'  '}</span>
      <span style={{ color: '#f85149' }}>{`−${dels}`}</span>
    </span>
  );
}

/** "Edited N files" result — icon tile, title, the file set, stats + actions. */
function EditedFilesResult() {
  return (
    <ResultRow onOpen={() => {}}>
      <ResultTile>
        <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="m10 13-2 2 2 2" /><path d="m14 13 2 2-2 2" />
        </svg>
      </ResultTile>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: '-0.2px', color: 'var(--cnv-ink)' }}>Edited 4 files</span>
        <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          dock.tsx · chat-card.tsx · page.tsx · canvas-persistence.ts
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 2 }}>
          <DiffStat adds={149} dels={276} />
          <span style={{ flex: 1 }} />
          <ActionChip label="Review" />
          <ActionChip label="Undo" />
        </div>
      </div>
    </ResultRow>
  );
}

/** PR result — icon tile (merged purple), title, number/repo/status, stats +
 *  checks. The same borderless shape, an opener for the pull request. */
function PrResult() {
  return (
    <ResultRow onOpen={() => {}}>
      <ResultTile tone="#a371f7">
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <line x1="6" x2="6" y1="3" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
      </ResultTile>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: '-0.2px', color: 'var(--cnv-ink)', lineHeight: 1.3 }}>
          Pinned dock + split-tab orchestrator modals
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink-muted)' }}>
          #374 · hurttlocker/o8
          <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: '#a371f7', flexShrink: 0 }} />
          merged
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 2 }}>
          <DiffStat adds={149} dels={276} />
          <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--cnv-ink-muted)' }}>
            <span style={{ color: '#3fb950' }}>✓</span> typecheck · lint · 89 tests
          </span>
        </div>
      </div>
    </ResultRow>
  );
}

/** Cortex side — a sample cited Brain answer, the same smooth surface. A
 *  user question, the streamed answer (no box), then titled citations. */
function SampleCortex() {
  return (
    <>
      <UserMessage text="Where does the orchestrator dock live now, and what carries the Cortex tab?" />

      {/* Retrieval beat — the 'Reading N sources' line settles into a count. */}
      <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.11em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', paddingTop: 2 }}>
        Read 7 sources · 0.3s
      </span>

      <span style={{ fontSize: 12.5, fontWeight: 300, lineHeight: 1.65, color: 'var(--cnv-ink)' }}>
        The dock is a <strong style={{ fontWeight: 500 }}>pinned right-edge panel</strong> — the floating role belongs to the chat-card modal. Every orchestrator surface (the dock and each spawned modal) carries the <strong style={{ fontWeight: 500 }}>Orchestrator | Cortex</strong> split, defaulting to Orchestrator, so the Brain is always one tab away.
      </span>

      <Citations sources={SOURCES} cited={SOURCES.length} considered={7} />
    </>
  );
}

/** Smooth citations — borderless titled pills (the titled-sources contract),
 *  a muted kind dot per source, then the 'N cited · M considered' caption. */
function Citations({ sources, cited, considered }: { sources: Array<{ kind: string; title: string }>; cited: number; considered: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 2 }}>
      <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0.11em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', opacity: 0.85 }}>
        Sources
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {sources.map((source) => (
          <span
            key={source.title}
            title={`${source.title} · ${source.kind}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              maxWidth: 220,
              background: 'var(--cnv-tint)',
              borderRadius: 9,
              paddingTop: 4,
              paddingBottom: 4,
              paddingLeft: 9,
              paddingRight: 11,
              fontSize: 11,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              color: 'var(--cnv-ink)',
            }}
          >
            <span aria-hidden style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--cnv-ink-muted)', flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source.title}</span>
          </span>
        ))}
      </div>
      <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)', opacity: 0.85 }}>
        {`${cited} cited · ${considered} considered`}
      </span>
    </div>
  );
}

/** A user message — right-aligned soft pill (no hard box, no border). The one
 *  speaker distinction in the smooth surface; agent content flows borderless. */
function UserMessage({ text }: { text: string }) {
  return (
    <div
      style={{
        alignSelf: 'flex-end',
        maxWidth: '82%',
        background: 'var(--cnv-tint)',
        borderRadius: 15,
        paddingTop: 8,
        paddingBottom: 8,
        paddingLeft: 13,
        paddingRight: 13,
        fontSize: 12.5,
        fontWeight: 300,
        lineHeight: 1.5,
        letterSpacing: '-0.1px',
        color: 'var(--cnv-ink)',
      }}
    >
      {text}
    </div>
  );
}

/** Compact composer — the canvas bottom-composer's style at card scale.
 *  - textarea grows with content via `field-sizing: content` (Q's tip),
 *    capped at ~5 rows then scrolls.
 *  - Input Anticipation (Q's tip): the focus ring fades in as the pointer
 *    nears the composer — the card reaches back before you click. Driven by
 *    direct style mutation off the render path.
 *  - send flips to stop while the orchestrator is working. */
function CompactComposer({ working = false }: { working?: boolean }) {
  const [draft, setDraft] = useState('');
  const boxRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const box = boxRef.current;
      const ring = ringRef.current;
      if (!box || !ring) return;
      const r = box.getBoundingClientRect();
      const dx = Math.max(r.left - event.clientX, 0, event.clientX - r.right);
      const dy = Math.max(r.top - event.clientY, 0, event.clientY - r.bottom);
      const distance = Math.hypot(dx, dy);
      const intent = Math.max(0, 1 - distance / 180) ** 2;
      ring.style.opacity = String(intent);
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  const inputStyle: React.CSSProperties & { fieldSizing?: 'content' } = {
    flex: 1,
    borderWidth: 0,
    outline: 'none',
    resize: 'none',
    background: 'transparent',
    color: 'var(--cnv-ink)',
    fontSize: 12.5,
    fontWeight: 300,
    letterSpacing: '-0.1px',
    fontFamily: FONT,
    lineHeight: 1.45,
    maxHeight: 104,
    overflowY: 'auto',
    fieldSizing: 'content',
  };
  return (
    <div style={{ flexShrink: 0, paddingLeft: 14, paddingRight: 14, paddingBottom: 14, paddingTop: 2 }}>
      <div
        ref={boxRef}
        style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 8, paddingTop: 7, paddingBottom: 7, paddingLeft: 13, paddingRight: 9, borderRadius: 18, background: 'var(--cnv-tint)' }}
      >
        {/* Input Anticipation focus ring — opacity driven by pointer proximity. */}
        <div
          ref={ringRef}
          aria-hidden
          style={{ position: 'absolute', inset: 0, borderRadius: 18, pointerEvents: 'none', opacity: 0, boxShadow: 'inset 0 0 0 1.5px var(--cnv-ink), 0 0 16px -4px var(--cnv-ink)' }}
        />
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) event.preventDefault(); }}
          rows={1}
          placeholder="Reply to this orchestrator"
          aria-label="Reply to this orchestrator"
          spellCheck={false}
          style={inputStyle}
        />
        <span style={{ fontSize: 10.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink-muted)', whiteSpace: 'nowrap', paddingBottom: 1 }}>
          Opus 4.8
        </span>
        <button
          type="button"
          aria-label={working ? 'Interrupt' : 'Send'}
          style={{ borderWidth: 0, background: 'transparent', padding: 3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--cnv-ink-muted)', flexShrink: 0 }}
          onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
        >
          {working ? (
            <svg width={13} height={13} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
