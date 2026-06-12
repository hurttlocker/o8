'use client';

/**
 * /preview/canvas-glass — the Canvas-mode material test page (#1232).
 *
 * Purpose: nail the glass BEFORE the real shell revamp. The full canvas
 * anatomy renders here, tunable live via the frost/tint/ink sliders +
 * material presets (top-right, same values as Settings → Operator
 * Defaults → Canvas mode):
 *
 *   - top dock        → the important header controls (NOT Symon — Symon
 *                       lives in the macOS dock above everything)
 *   - left spawn dock → spawn objects onto the canvas (orchestrator,
 *                       browser, o8.md, terminal)
 *   - left/right edge → hover-reveal rails (sessions / activity feedback)
 *   - bottom input    → the orchestrator composer for the scoped repo
 *   - glass cards     → packet-objects; drag them, Enter in the composer
 *                       summons them
 *
 * In the o8 app the window swaps to the Popover vibrancy material
 * (set_canvas_material) and the page paints NOTHING behind the glass —
 * the real desktop reads through, the Symon-settings clarity. In a plain
 * browser the diffusion backdrop stands in for the desktop.
 *
 * Empty canvas = the kivo-style stage (blurrhaus reference): a pulsing
 * idle element with cycling hints; Enter in the composer runs the
 * summon transition and fans agent cards out in an arc. This is the
 * "orchestrator/Symon uses the canvas when nothing is there" motion.
 *
 * Everything here is a mock — no backend, no dispatch. Gated on the
 * experimentalCanvas operator flag like every canvas surface.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CANVAS_GLASS_DEFAULTS,
  CANVAS_GLASS_PRESETS,
  CANVAS_GLASS_RANGES,
  applyCanvasGlassSettings,
  readCanvasGlassSettings,
  writeCanvasGlassSettings,
  type CanvasGlassSettings,
} from '@/lib/canvas-mode/glass-settings';
import { useExperimentalCanvasFlag } from '@/lib/operator/use-experimental-canvas';
import { isTauri, setCanvasMaterial } from '@/lib/tauri/bridge';

const FONT = 'var(--font-sans-system)';

/** The one glass recipe — every surface consumes the tunable vars. */
function glass(deep = false): CSSProperties {
  return {
    background: deep ? 'var(--cnv-tint-deep)' : 'var(--cnv-tint)',
    backdropFilter: 'blur(var(--cnv-frost)) saturate(160%)',
    WebkitBackdropFilter: 'blur(var(--cnv-frost)) saturate(160%)',
    border: '1px solid var(--cnv-edge)',
    color: 'var(--cnv-ink)',
    boxShadow: '0 12px 40px rgba(0, 0, 0, 0.35)',
  } as CSSProperties;
}

interface MockCard {
  id: number;
  title: string;
  meta: string;
  tone: 'working' | 'waiting' | 'idle';
  x: number;
  y: number;
  /** Entry-animation stagger (s) — set for arc fan-outs. */
  entryDelay?: number;
}

const TONE_DOT: Record<MockCard['tone'], string> = {
  working: '#22c55e',
  waiting: '#f59e0b',
  idle: 'rgba(255,255,255,0.4)',
};

const IDLE_HINTS = [
  'The canvas is listening',
  'Type below — Enter builds onto the canvas',
  'Spawn from the left dock',
  'Symon can drive this surface by voice',
];

type Stage = { kind: 'idle' } | { kind: 'summoning'; prompt: string };

export default function CanvasGlassPreviewPage() {
  const canvasEnabled = useExperimentalCanvasFlag();
  const [settings, setSettings] = useState<CanvasGlassSettings>(CANVAS_GLASS_DEFAULTS);
  const [cards, setCards] = useState<MockCard[]>([]);
  const [leftRailOpen, setLeftRailOpen] = useState(false);
  const [rightRailOpen, setRightRailOpen] = useState(false);
  const [composerValue, setComposerValue] = useState('');
  const [inTauri, setInTauri] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const nextIdRef = useRef(1);
  const summonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const stored = readCanvasGlassSettings();
    setSettings(stored);
    applyCanvasGlassSettings(stored);
    setInTauri(isTauri());
  }, []);

  // Desktop-clear glass: swap the window to the Popover material while this
  // page is up, restore the HudWindow chrome on the way out. No-op in a
  // plain browser.
  useEffect(() => {
    if (!canvasEnabled) return;
    void setCanvasMaterial(true);
    return () => {
      void setCanvasMaterial(false);
      if (summonTimerRef.current) clearTimeout(summonTimerRef.current);
    };
  }, [canvasEnabled]);

  const updateSettings = useCallback((patch: Partial<CanvasGlassSettings>) => {
    setSettings((previous) => {
      const next = { ...previous, ...patch };
      writeCanvasGlassSettings(next);
      return next;
    });
  }, []);

  const spawnCard = useCallback((title: string, meta: string, tone: MockCard['tone']) => {
    setCards((previous) => {
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      const column = previous.length % 3;
      const row = Math.floor(previous.length / 3) % 3;
      return [...previous, {
        id,
        title,
        meta,
        tone,
        x: 300 + column * 240 + (id % 5) * 8,
        y: 160 + row * 120 + (id % 7) * 6,
      }];
    });
  }, []);

  /** The kivo transition — summon state, then agents fan out in an arc. */
  const summonArc = useCallback((prompt: string) => {
    setStage({ kind: 'summoning', prompt });
    summonTimerRef.current = setTimeout(() => {
      setCards((previous) => {
        const width = typeof window !== 'undefined' ? window.innerWidth : 1280;
        const height = typeof window !== 'undefined' ? window.innerHeight : 800;
        const centerX = width / 2 - 105;
        const baseY = height * 0.32;
        const arc = [
          { dx: -290, dy: 44, title: `Plan — ${prompt}`, meta: 'o8 · orchestrator · scoping', tone: 'idle' as const },
          { dx: 0, dy: -14, title: prompt, meta: 'o8 · codex · dispatched', tone: 'working' as const },
          { dx: 290, dy: 44, title: `Review — ${prompt}`, meta: 'o8 · gate · queued', tone: 'waiting' as const },
        ];
        const spawned = arc.map((slot, index) => {
          const id = nextIdRef.current;
          nextIdRef.current += 1;
          return {
            id,
            title: slot.title.slice(0, 46),
            meta: slot.meta,
            tone: slot.tone,
            x: Math.max(16, centerX + slot.dx),
            y: Math.max(70, baseY + slot.dy),
            entryDelay: index * 0.14,
          };
        });
        return [...previous, ...spawned];
      });
      setStage({ kind: 'idle' });
    }, 1300);
  }, []);

  const moveCard = useCallback((id: number, x: number, y: number) => {
    setCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
  }, []);

  if (!canvasEnabled) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0c10', fontFamily: FONT }}>
        <span style={{ fontSize: 13, fontWeight: 300, color: 'rgba(255,255,255,0.65)', letterSpacing: '-0.1px', textAlign: 'center', lineHeight: 1.6, maxWidth: 380 }}>
          Canvas mode is off.
          <br />
          Enable “Experimental: Canvas mode” in Settings → Operator Defaults to unlock this surface.
        </span>
      </div>
    );
  }

  const summoning = stage.kind === 'summoning';

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', fontFamily: FONT, background: inTauri ? 'transparent' : '#07090d', userSelect: 'none' }}>
      {/* In the app the desktop IS the backdrop (Popover material). The
          diffusion only stands in where there is no desktop to show. */}
      {inTauri ? null : <DiffusionBackdrop />}

      {/* ── Kivo stage — owns the canvas while it is empty ───────── */}
      <AnimatePresence mode="wait">
        {cards.length === 0 || summoning ? (
          <CenterStage key={stage.kind} stage={stage} />
        ) : null}
      </AnimatePresence>

      {/* ── Glass cards (packet-objects) ─────────────────────────── */}
      {cards.map((card) => (
        <PacketGlassCard key={card.id} card={card} onMove={moveCard} />
      ))}

      {/* ── Top dock — the important header controls ─────────────── */}
      <div
        style={{
          position: 'absolute',
          top: 18,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: 40,
          paddingLeft: 16,
          paddingRight: 10,
          borderRadius: 20,
          ...glass(true),
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 500, letterSpacing: '0.02em' }}>o8</span>
        <span style={{ width: 1, height: 16, background: 'var(--cnv-edge)' }} />
        <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink-muted)' }}>Canvas</span>
        <span style={{ width: 1, height: 16, background: 'var(--cnv-edge)' }} />
        <DockGlyphButton label="Agents" path="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" extra={<circle cx="9" cy="7" r="4" />} />
        <DockGlyphButton label="Alerts" path="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        <DockGlyphButton label="Settings" path="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" extra={<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />} />
        <span style={{ width: 1, height: 16, background: 'var(--cnv-edge)' }} />
        <button
          type="button"
          onClick={() => {
            // Restore the chrome material BEFORE the hard navigation — the
            // unmount cleanup is not guaranteed across location.assign.
            void setCanvasMaterial(false).finally(() => {
              window.location.assign('/dashboard');
            });
          }}
          style={{
            borderWidth: 0,
            background: 'transparent',
            padding: 0,
            paddingLeft: 4,
            paddingRight: 6,
            fontSize: 11,
            fontWeight: 300,
            color: 'var(--cnv-ink-muted)',
            cursor: 'pointer',
            fontFamily: FONT,
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
        >
          Exit
        </button>
      </div>

      {/* ── Left spawn dock ──────────────────────────────────────── */}
      <div
        style={{
          position: 'absolute',
          left: 16,
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          paddingTop: 10,
          paddingBottom: 10,
          paddingLeft: 6,
          paddingRight: 6,
          borderRadius: 16,
          ...glass(true),
        }}
      >
        <SpawnGlyphButton label="Spawn orchestrator" onClick={() => spawnCard('Orchestrator · o8', 'fleet · ready', 'idle')}>
          <circle cx="12" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><path d="M12 8v4M12 12l-6 4M12 12l6 4" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Spawn browser" onClick={() => spawnCard('Browser', 'localhost:3001', 'idle')}>
          <circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Spawn o8.md notes" onClick={() => spawnCard('o8.md · o8', 'workspace notes', 'idle')}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Spawn terminal" onClick={() => spawnCard('Terminal', 'zsh · ~/o8', 'idle')}>
          <path d="m4 17 6-6-6-6" /><line x1="12" x2="20" y1="19" y2="19" />
        </SpawnGlyphButton>
      </div>

      {/* ── Edge hover rails ─────────────────────────────────────── */}
      <EdgeRail
        side="left"
        open={leftRailOpen}
        onOpenChange={setLeftRailOpen}
        title="Sessions"
        rows={[
          ['Quick round-trip check', 'orchestrator · 1h ago'],
          ['Polish group C', 'merged · 2h ago'],
          ['Fleet canvas v1', 'merged · 1h ago'],
        ]}
      />
      <EdgeRail
        side="right"
        open={rightRailOpen}
        onOpenChange={setRightRailOpen}
        title="Activity"
        rows={[
          ['0.1.354 shipped', 'release · just now'],
          ['feat(canvas): v2 glass slice', 'main · 10m ago'],
          ['fix(workspace): tab persistence', 'main · 1h ago'],
        ]}
      />

      {/* ── Bottom orchestrator input ────────────────────────────── */}
      <div
        style={{
          position: 'absolute',
          bottom: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'min(620px, calc(100vw - 220px))',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: 48,
          paddingLeft: 18,
          paddingRight: 12,
          borderRadius: 24,
          ...glass(true),
        }}
      >
        <input
          value={composerValue}
          onChange={(event) => setComposerValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && composerValue.trim() && !summoning) {
              const prompt = composerValue.trim().slice(0, 42);
              if (cards.length === 0) {
                summonArc(prompt);
              } else {
                spawnCard(prompt, 'o8 · codex · dispatched', 'working');
              }
              setComposerValue('');
            }
          }}
          placeholder="Message the orchestrator · o8"
          aria-label="Orchestrator composer (mock)"
          style={{
            flex: 1,
            borderWidth: 0,
            outline: 'none',
            background: 'transparent',
            color: 'var(--cnv-ink)',
            fontSize: 13,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            fontFamily: FONT,
          }}
        />
        <span style={{ fontSize: 10, fontWeight: 300, color: 'var(--cnv-ink-muted)', flexShrink: 0 }}>
          {cards.length === 0 ? 'Enter summons the fleet' : 'Enter spawns a card'}
        </span>
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
          <path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" />
        </svg>
      </div>

      <TunerPanel settings={settings} onChange={updateSettings} inTauri={inTauri} />
    </div>
  );
}

/** The kivo-borrow center stage: a pulsing idle element with cycling hints,
 *  morphing into an orbiting summon spinner while the fleet materialises. */
function CenterStage({ stage }: { stage: Stage }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.06 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      style={{
        position: 'absolute',
        left: '50%',
        top: '38%',
        transform: 'translate(-50%, -50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 22,
        pointerEvents: 'none',
        zIndex: 2,
      }}
    >
      {stage.kind === 'summoning' ? <SummonRings /> : <IdlePulse />}
      {stage.kind === 'summoning' ? (
        <span style={{ fontSize: 12.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink-muted)', fontFamily: FONT }}>
          Summoning — {stage.prompt}
        </span>
      ) : (
        <CyclingHint />
      )}
    </motion.div>
  );
}

function IdlePulse() {
  return (
    <div style={{ position: 'relative', width: 84, height: 84, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <motion.span
        aria-hidden
        animate={{ scale: [1, 1.16, 1], opacity: [0.4, 0.75, 0.4] }}
        transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut' }}
        style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1px solid var(--cnv-edge)', background: 'var(--cnv-tint)' }}
      />
      <motion.span
        aria-hidden
        animate={{ scale: [1, 1.08, 1], opacity: [0.7, 1, 0.7] }}
        transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut', delay: 0.35 }}
        style={{ position: 'absolute', inset: 18, borderRadius: '50%', border: '1px solid var(--cnv-edge)' }}
      />
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--cnv-ink)' }} />
    </div>
  );
}

function SummonRings() {
  return (
    <div style={{ position: 'relative', width: 84, height: 84, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <motion.span
        aria-hidden
        animate={{ rotate: 360 }}
        transition={{ duration: 2.2, repeat: Infinity, ease: 'linear' }}
        style={{ position: 'absolute', inset: 6, borderRadius: '50%', border: '1px solid transparent', borderTopColor: 'var(--cnv-ink)', borderRightColor: 'var(--cnv-edge)' }}
      />
      <motion.span
        aria-hidden
        animate={{ rotate: -360 }}
        transition={{ duration: 3.4, repeat: Infinity, ease: 'linear' }}
        style={{ position: 'absolute', inset: 20, borderRadius: '50%', border: '1px solid transparent', borderBottomColor: 'var(--cnv-ink-muted)', borderLeftColor: 'var(--cnv-edge)' }}
      />
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--cnv-ink)' }} />
    </div>
  );
}

function CyclingHint() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((value) => (value + 1) % IDLE_HINTS.length);
    }, 4000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div style={{ height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <AnimatePresence mode="wait">
        <motion.span
          key={index}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.45, ease: 'easeOut' }}
          style={{ fontSize: 12.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink-muted)', fontFamily: FONT, whiteSpace: 'nowrap' }}
        >
          {IDLE_HINTS[index]}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

/** Slow drifting colour fields — the diffusion behind the glass. Browser-only
 *  stand-in for the real desktop that the app's Popover material shows. */
function DiffusionBackdrop() {
  const blobs: Array<{ size: number; color: string; from: { x: string; y: string }; to: { x: string; y: string }; duration: number }> = [
    { size: 560, color: 'rgba(58, 96, 255, 0.32)', from: { x: '-6%', y: '8%' }, to: { x: '14%', y: '26%' }, duration: 46 },
    { size: 640, color: 'rgba(255, 122, 60, 0.20)', from: { x: '68%', y: '58%' }, to: { x: '52%', y: '40%' }, duration: 58 },
    { size: 480, color: 'rgba(160, 84, 255, 0.22)', from: { x: '38%', y: '-12%' }, to: { x: '54%', y: '4%' }, duration: 52 },
    { size: 520, color: 'rgba(34, 197, 94, 0.12)', from: { x: '10%', y: '70%' }, to: { x: '26%', y: '56%' }, duration: 64 },
  ];
  return (
    <div aria-hidden style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      {blobs.map((blob, index) => (
        <motion.div
          key={index}
          animate={{ left: [blob.from.x, blob.to.x, blob.from.x], top: [blob.from.y, blob.to.y, blob.from.y] }}
          transition={{ duration: blob.duration, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            position: 'absolute',
            width: blob.size,
            height: blob.size,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${blob.color} 0%, transparent 70%)`,
            filter: 'blur(40px)',
          }}
        />
      ))}
    </div>
  );
}

function PacketGlassCard({ card, onMove }: { card: MockCard; onMove: (id: number, x: number, y: number) => void }) {
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const working = card.tone === 'working';
  return (
    <motion.div
      initial={{ scale: 0.62, opacity: 0, y: 26 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 28, delay: card.entryDelay ?? 0 }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: card.x, originY: card.y };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        onMove(card.id, Math.max(4, drag.originX + event.clientX - drag.startX), Math.max(4, drag.originY + event.clientY - drag.startY));
      }}
      onPointerUp={() => { dragRef.current = null; }}
      style={{
        position: 'absolute',
        left: card.x,
        top: card.y,
        width: 210,
        borderRadius: 14,
        cursor: 'grab',
        touchAction: 'none',
        zIndex: 3,
      }}
    >
      <motion.div
        animate={working ? { scale: [1, 1.015, 1], opacity: [1, 0.93, 1] } : { scale: 1, opacity: 1 }}
        transition={working ? { duration: 3.2, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.2 }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
          paddingTop: 11,
          paddingRight: 13,
          paddingBottom: 11,
          paddingLeft: 13,
          borderRadius: 14,
          ...glass(),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: TONE_DOT[card.tone] }} />
          <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {card.title}
          </span>
        </div>
        <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)', letterSpacing: '0.01em' }}>
          {card.meta}
        </span>
      </motion.div>
    </motion.div>
  );
}

function EdgeRail({
  side,
  open,
  onOpenChange,
  title,
  rows,
}: {
  side: 'left' | 'right';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  rows: Array<[string, string]>;
}) {
  const zoneRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  // Close only when the pointer truly leaves the zone+rail union — the rail
  // sits flush against the strip so travel between them never drops out.
  const closeUnlessWithin = (event: ReactMouseEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && (zoneRef.current?.contains(next) || railRef.current?.contains(next))) return;
    onOpenChange(false);
  };
  return (
    <>
      {/* Hot zone — an 18px strip on the screen edge reveals the rail. */}
      <div
        ref={zoneRef}
        onMouseEnter={() => onOpenChange(true)}
        onMouseLeave={closeUnlessWithin}
        style={{
          position: 'absolute',
          top: 80,
          bottom: 96,
          width: 18,
          ...(side === 'left' ? { left: 0 } : { right: 0 }),
          zIndex: 5,
        }}
      />
      <motion.div
        ref={railRef}
        onMouseLeave={closeUnlessWithin}
        initial={false}
        animate={{
          x: open ? 0 : side === 'left' ? -252 : 252,
          opacity: open ? 1 : 0,
        }}
        transition={{ type: 'spring', stiffness: 400, damping: 34 }}
        style={{
          position: 'absolute',
          top: 96,
          ...(side === 'left' ? { left: 18 } : { right: 18 }),
          width: 236,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          paddingTop: 12,
          paddingRight: 12,
          paddingBottom: 12,
          paddingLeft: 12,
          borderRadius: 14,
          zIndex: 6,
          pointerEvents: open ? 'auto' : 'none',
          ...glass(true),
        }}
      >
        <span style={{ fontSize: 10, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', marginBottom: 6 }}>
          {title}
        </span>
        {rows.map(([primary, secondary]) => (
          <div key={primary} style={{ display: 'flex', flexDirection: 'column', gap: 1, paddingTop: 5, paddingBottom: 5 }}>
            <span style={{ fontSize: 12.5, fontWeight: 300, letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {primary}
            </span>
            <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)' }}>{secondary}</span>
          </div>
        ))}
      </motion.div>
    </>
  );
}

function DockGlyphButton({ label, path, extra }: { label: string; path: string; extra?: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        borderWidth: 0,
        borderRadius: 13,
        background: 'transparent',
        color: 'var(--cnv-ink-muted)',
        cursor: 'pointer',
        padding: 0,
      }}
      onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
    >
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={path} />
        {extra}
      </svg>
    </button>
  );
}

function SpawnGlyphButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 34,
        height: 34,
        borderWidth: 0,
        borderRadius: 11,
        background: 'transparent',
        color: 'var(--cnv-ink-muted)',
        cursor: 'pointer',
        padding: 0,
        transition: 'background 120ms',
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.color = 'var(--cnv-ink)';
        event.currentTarget.style.background = 'rgba(255,255,255,0.08)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.color = 'var(--cnv-ink-muted)';
        event.currentTarget.style.background = 'transparent';
      }}
    >
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

function TunerPanel({ settings, onChange, inTauri }: { settings: CanvasGlassSettings; onChange: (patch: Partial<CanvasGlassSettings>) => void; inTauri: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div
      style={{
        position: 'absolute',
        top: 18,
        right: 16,
        width: collapsed ? undefined : 224,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        paddingTop: 10,
        paddingRight: 12,
        paddingBottom: 12,
        paddingLeft: 12,
        borderRadius: 14,
        zIndex: 8,
        ...glass(true),
      }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          borderWidth: 0,
          background: 'transparent',
          padding: 0,
          color: 'var(--cnv-ink)',
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          cursor: 'pointer',
          fontFamily: FONT,
        }}
      >
        Glass tuner
        <span style={{ fontSize: 10, fontWeight: 300, color: 'var(--cnv-ink-muted)' }}>{collapsed ? 'show' : 'hide'}</span>
      </button>
      {collapsed ? null : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {CANVAS_GLASS_PRESETS.map((preset) => {
              const active = settings.frost === preset.values.frost
                && settings.tint === preset.values.tint
                && settings.ink === preset.values.ink;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => onChange({ ...preset.values })}
                  style={{
                    flex: 1,
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: active ? 'var(--cnv-ink-muted)' : 'var(--cnv-edge)',
                    background: active ? 'rgba(255,255,255,0.1)' : 'transparent',
                    borderRadius: 999,
                    paddingTop: 3,
                    paddingBottom: 3,
                    fontSize: 10.5,
                    fontWeight: active ? 500 : 300,
                    color: active ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
                    cursor: 'pointer',
                    fontFamily: FONT,
                  }}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
          <TunerSlider label="Frost" display={`${Math.round(settings.frost)}px`} value={settings.frost} range={CANVAS_GLASS_RANGES.frost} onChange={(frost) => onChange({ frost })} />
          <TunerSlider label="Tint" display={`${Math.round(settings.tint * 100)}%`} value={settings.tint} range={CANVAS_GLASS_RANGES.tint} onChange={(tint) => onChange({ tint })} />
          <TunerSlider label="Ink" display={`${Math.round(settings.ink * 100)}%`} value={settings.ink} range={CANVAS_GLASS_RANGES.ink} onChange={(ink) => onChange({ ink })} />
          <button
            type="button"
            onClick={() => onChange({ ...CANVAS_GLASS_DEFAULTS })}
            style={{
              alignSelf: 'flex-start',
              borderWidth: 0,
              background: 'transparent',
              padding: 0,
              fontSize: 10.5,
              fontWeight: 300,
              color: 'var(--cnv-ink-muted)',
              cursor: 'pointer',
              fontFamily: FONT,
            }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            Reset defaults
          </button>
          {inTauri ? null : (
            <span style={{ fontSize: 9.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', lineHeight: 1.5 }}>
              Open in the o8 app to see your desktop through the glass.
            </span>
          )}
        </>
      )}
    </div>
  );
}

function TunerSlider({
  label,
  display,
  value,
  range,
  onChange,
}: {
  label: string;
  display: string;
  value: number;
  range: { min: number; max: number; step: number };
  onChange: (value: number) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--cnv-ink)' }}>{label}</span>
        <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontVariantNumeric: 'tabular-nums' }}>{display}</span>
      </div>
      <input
        type="range"
        aria-label={`Canvas glass ${label.toLowerCase()}`}
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        onChange={(event) => {
          const next = Number.parseFloat(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        style={{ width: '100%', accentColor: '#f59e0b', cursor: 'pointer' }}
      />
    </div>
  );
}
