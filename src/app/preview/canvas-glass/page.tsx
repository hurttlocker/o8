'use client';

/**
 * /preview/canvas-glass — the Canvas-mode material + motion test page (#1232).
 *
 * Purpose: nail the glass and the design language BEFORE the real shell
 * revamp. Anatomy (all mock — no backend, no dispatch):
 *
 *   - top dock        → the important header controls (NOT Symon — Symon
 *                       lives in the macOS dock above everything) + the
 *                       orchestrator-dock toggle
 *   - left spawn dock → spawn component cards: orchestrator packet,
 *                       browser, terminal, review/diff, o8.md notes
 *   - left/right edge → hover-reveal rails (sessions / activity)
 *   - bottom input    → the orchestrator composer for the scoped repo;
 *                       first contact ALWAYS happens here
 *   - right dock      → OPT-IN (a creator borrow): dock the
 *                       conversation after you've talked, or open it to
 *                       see every running orchestrator and switch lanes.
 *                       Fades into the canvas — no hard panel.
 *   - glass cards     → draggable component cards; drop an image anywhere
 *                       and it piles "in the back" (desktop-on-desktop)
 *
 * In the o8 app the window swaps to the operator's chosen native material
 * (set_canvas_material) and the page paints NOTHING behind the glass —
 * the real desktop reads through ("Liquid" = raw transparent, sharpest).
 * In a plain browser the diffusion backdrop stands in for the desktop.
 * Gated on the experimentalCanvas operator flag like every canvas surface.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CANVAS_GLASS_DEFAULTS,
  applyCanvasGlassSettings,
  readCanvasGlassSettings,
  writeCanvasGlassSettings,
  type CanvasGlassSettings,
} from '@/lib/canvas-mode/glass-settings';
import { useExperimentalCanvasFlag } from '@/lib/operator/use-experimental-canvas';
import { isTauri, setCanvasMaterial } from '@/lib/tauri/bridge';
import { CanvasCard } from './cards';
import { DiffusionBackdrop, DockGlyphButton, EdgeRail, SpawnGlyphButton } from './chrome';
import { MOCK_LANES, OrchestratorDock } from './dock';
import { CenterStage, type Stage } from './stage';
import { TunerPanel } from './tuner';
import { FONT, glass, type CardKind, type DockEntry, type MockCard, type NewDockEntry } from './ui';

export default function CanvasGlassPreviewPage() {
  const canvasEnabled = useExperimentalCanvasFlag();
  const [settings, setSettings] = useState<CanvasGlassSettings>(CANVAS_GLASS_DEFAULTS);
  const [cards, setCards] = useState<MockCard[]>([]);
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null);
  const [leftRailOpen, setLeftRailOpen] = useState(false);
  const [rightRailOpen, setRightRailOpen] = useState(false);
  const [composerValue, setComposerValue] = useState('');
  const [inTauri, setInTauri] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [dockOpen, setDockOpen] = useState(false);
  const [activeLane, setActiveLane] = useState(MOCK_LANES[0].id);
  const [convos, setConvos] = useState<Record<string, DockEntry[]>>({});
  const nextIdRef = useRef(1);
  const entryIdRef = useRef(1);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  useEffect(() => {
    const stored = readCanvasGlassSettings();
    setSettings(stored);
    applyCanvasGlassSettings(stored);
    setInTauri(isTauri());
  }, []);

  // Background material: apply the stored choice while this page is up,
  // restore the HudWindow chrome on the way out. No-op in a plain browser.
  useEffect(() => {
    if (!canvasEnabled) return;
    void setCanvasMaterial(readCanvasGlassSettings().material);
    const timers = timersRef.current;
    return () => {
      void setCanvasMaterial('default');
      for (const timer of timers) clearTimeout(timer);
    };
  }, [canvasEnabled]);

  const updateSettings = useCallback((patch: Partial<CanvasGlassSettings>) => {
    // Material is native, not CSS — swap the window live when it changes.
    if (patch.material) void setCanvasMaterial(patch.material);
    setSettings((previous) => {
      const next = { ...previous, ...patch };
      writeCanvasGlassSettings(next);
      return next;
    });
  }, []);

  const schedule = useCallback((fn: () => void, ms: number) => {
    timersRef.current.push(setTimeout(fn, ms));
  }, []);

  const spawnCard = useCallback((kind: CardKind, title: string, meta: string, tone: MockCard['tone'], at?: { x: number; y: number }, src?: string) => {
    setCards((previous) => {
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      const column = previous.length % 3;
      const row = Math.floor(previous.length / 3) % 3;
      return [...previous, {
        id,
        kind,
        title,
        meta,
        tone,
        x: at ? at.x : 300 + column * 250 + (id % 5) * 8,
        y: at ? at.y : 150 + row * 130 + (id % 7) * 6,
        src,
      }];
    });
  }, []);

  /** The the reference transition — summon state, then agents fan out in an arc. */
  const summonArc = useCallback((prompt: string) => {
    setStage({ kind: 'summoning', prompt });
    schedule(() => {
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
            kind: 'packet' as const,
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
  }, [schedule]);

  const appendEntries = useCallback((lane: string, entries: NewDockEntry[]) => {
    setConvos((previous) => {
      const next: DockEntry[] = entries.map((entry) => {
        const id = entryIdRef.current;
        entryIdRef.current += 1;
        return { ...entry, id };
      });
      return { ...previous, [lane]: [...(previous[lane] ?? []).filter((e) => e.role !== 'followups'), ...next] };
    });
  }, []);

  const resolveStatus = useCallback((lane: string, text: string) => {
    setConvos((previous) => ({
      ...previous,
      [lane]: (previous[lane] ?? []).map((entry) => (
        entry.role === 'status' && entry.pending ? { ...entry, pending: false, text } : entry
      )),
    }));
  }, []);

  const submit = useCallback(() => {
    const prompt = composerValue.trim().slice(0, 42);
    if (!prompt || stage.kind === 'summoning') return;
    const lane = activeLane;
    appendEntries(lane, [
      { role: 'user', text: prompt },
      { role: 'status', text: 'Summoning the fleet', pending: true },
    ]);
    const empty = cards.length === 0;
    if (empty) {
      summonArc(prompt);
    } else {
      spawnCard('packet', prompt, 'o8 · codex · dispatched', 'working');
    }
    const explanation = `Dispatched a Plan / Build / Review lane for “${prompt}”. The builder runs in an isolated worktree; the review gate holds before anything touches main.`;
    schedule(() => {
      resolveStatus(lane, 'Fleet dispatched');
      appendEntries(lane, [
        { role: 'result', title: prompt, meta: 'o8 · codex · dispatched' },
        { role: 'text', text: explanation },
      ]);
      schedule(() => {
        appendEntries(lane, [{ role: 'followups' }]);
      }, explanation.split(' ').length * 38 + 350);
    }, empty ? 1350 : 700);
    setComposerValue('');
  }, [activeLane, appendEntries, cards.length, composerValue, resolveStatus, schedule, spawnCard, stage.kind, summonArc]);

  const moveCard = useCallback((id: number, x: number, y: number) => {
    setCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
  }, []);

  const dropImages = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith('image/'));
    files.forEach((file, index) => {
      spawnCard(
        'image',
        file.name,
        `${Math.round(file.size / 1024)} KB`,
        'idle',
        { x: Math.max(8, event.clientX - 100 + index * 26), y: Math.max(64, event.clientY - 60 + index * 26) },
        URL.createObjectURL(file),
      );
    });
  }, [spawnCard]);

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
  const activeConvo = convos[activeLane] ?? [];
  const hasTalked = Object.values(convos).some((entries) => entries.length > 0);

  return (
    <div
      onDragOver={(event) => { event.preventDefault(); }}
      onDrop={dropImages}
      style={{ position: 'fixed', inset: 0, overflow: 'hidden', fontFamily: FONT, background: inTauri ? 'transparent' : '#07090d', userSelect: 'none' }}
    >
      {/* In the app the desktop IS the backdrop (native material). The
          diffusion only stands in where there is no desktop to show. */}
      {inTauri ? null : <DiffusionBackdrop />}

      {/* Window-wide veil + the canvas dot grid — the continuous darkness
          control for the background itself, painted over the material. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          background: 'var(--cnv-bg-veil)',
          backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.055) 1px, transparent 1.4px)',
          backgroundSize: '26px 26px',
          pointerEvents: 'none',
          zIndex: 1,
        }}
      />

      {/* ── the reference stage — owns the canvas while it is empty ───────── */}
      <AnimatePresence mode="wait">
        {cards.length === 0 || summoning ? (
          <CenterStage key={stage.kind} stage={stage} />
        ) : null}
      </AnimatePresence>

      {/* ── Component cards ──────────────────────────────────────── */}
      {cards.map((card) => (
        <CanvasCard key={card.id} card={card} selected={selectedCardId === card.id} onMove={moveCard} onSelect={setSelectedCardId} />
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
          zIndex: 4,
          ...glass(true),
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 500, letterSpacing: '0.02em' }}>o8</span>
        <span style={{ width: 1, height: 16, background: 'var(--cnv-edge)' }} />
        <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink-muted)' }}>Canvas</span>
        <span style={{ width: 1, height: 16, background: 'var(--cnv-edge)' }} />
        <DockGlyphButton label="Agents" path="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" extra={<circle cx="9" cy="7" r="4" />} />
        <DockGlyphButton label="Alerts" path="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        <DockGlyphButton
          label="Orchestrators"
          active={dockOpen}
          onClick={() => setDockOpen((value) => !value)}
          path="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
          extra={<path d="M15 3v18" />}
        />
        <span style={{ width: 1, height: 16, background: 'var(--cnv-edge)' }} />
        <button
          type="button"
          onClick={() => {
            // Restore the chrome material BEFORE the hard navigation — the
            // unmount cleanup is not guaranteed across location.assign.
            void setCanvasMaterial('default').finally(() => {
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

      {/* ── Left spawn dock — the component vocabulary ───────────── */}
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
          zIndex: 4,
          ...glass(true),
        }}
      >
        <SpawnGlyphButton label="Spawn orchestrator" onClick={() => spawnCard('packet', 'Orchestrator · o8', 'fleet · ready', 'idle')}>
          <circle cx="12" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><path d="M12 8v4M12 12l-6 4M12 12l6 4" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Spawn browser" onClick={() => spawnCard('browser', 'Browser', 'localhost:3001', 'idle')}>
          <circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Spawn terminal" onClick={() => spawnCard('terminal', 'zsh · ~/o8', 'agent terminal', 'working')}>
          <path d="m4 17 6-6-6-6" /><line x1="12" x2="20" y1="19" y2="19" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Spawn review" onClick={() => spawnCard('review', 'Review — pending diff', '2 files · +14 −3', 'waiting')}>
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect width="8" height="4" x="8" y="2" rx="1" /><path d="m9 14 2 2 4-4" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Spawn o8.md notes" onClick={() => spawnCard('packet', 'o8.md · o8', 'workspace notes', 'idle')}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
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
      {dockOpen ? null : (
        <EdgeRail
          side="right"
          open={rightRailOpen}
          onOpenChange={setRightRailOpen}
          title="Activity"
          rows={[
            ['0.1.356 shipped', 'release · just now'],
            ['feat(canvas): background controls', 'main · 10m ago'],
            ['feat(canvas): v2 glass slice', 'main · 1h ago'],
          ]}
        />
      )}

      {/* ── The docked orchestrator (opt-in, a creator borrow) ── */}
      <AnimatePresence>
        {dockOpen ? (
          <OrchestratorDock
            entries={activeConvo}
            activeLane={activeLane}
            onSelectLane={setActiveLane}
            onClose={() => setDockOpen(false)}
          />
        ) : null}
      </AnimatePresence>

      {/* Dock affordance — appears once you have talked, until docked. */}
      <AnimatePresence>
        {hasTalked && !dockOpen ? (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
            onClick={() => setDockOpen(true)}
            style={{
              position: 'absolute',
              bottom: 86,
              right: 24,
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              paddingTop: 6,
              paddingBottom: 6,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 999,
              cursor: 'pointer',
              zIndex: 4,
              fontSize: 10.5,
              fontWeight: 300,
              color: 'var(--cnv-ink-muted)',
              fontFamily: FONT,
              ...glass(true),
            }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            Dock orchestrator
            <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M15 3v18" />
            </svg>
          </motion.button>
        ) : null}
      </AnimatePresence>

      {/* ── Bottom orchestrator input — first contact lives here ─── */}
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
          zIndex: 4,
          ...glass(true),
        }}
      >
        <input
          value={composerValue}
          onChange={(event) => setComposerValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
          placeholder={`Message the orchestrator · ${activeLane}`}
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

      <TunerPanel settings={settings} onChange={updateSettings} inTauri={inTauri} right={dockOpen ? 348 : 16} />
    </div>
  );
}
