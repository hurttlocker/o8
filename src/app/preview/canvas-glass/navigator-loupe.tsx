'use client';

/**
 * NavigatorLoupe (#1239) — the bottom-left canvas navigator that replaces the
 * zoom-level chip. A circular minimap of the canvas content with a Free/Grid
 * switch + −/fit/+ zoom in ONE clean bottom cluster.
 *
 * The orb-refraction tuner is admin-only: its gear button is hidden. Open it
 * with ⌥⇧O, or dispatch the `o8:toggle-orb-tuner` window event.
 *
 * Visual ref: operator screenshot — a small glass circle showing the cards as an
 * overview, a dark pill at its lower edge.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { FONT, glass } from './ui';
import { RefractionBall } from './refraction-ball';
import { OrbTuner } from './orb-tuner';
import type { CanvasTone, OrbSettings } from './orb-settings';

/** Roll sensitivity — drag the ball N screen-px → pan the view N×this. The ball
 *  is small but represents a big plane, so a drag travels further than the grab. */
const ROLL_SENS = 4.5;

/** Idle delay before the loupe slides out of the way, and how close to the
 *  bottom-left corner the cursor must come to call it back. */
const HIDE_MS = 2800;
const REVEAL_NEAR_PX = 150;

export interface MinimapCard {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: string;
  /** image cards render their real thumbnail in the minimap. */
  src?: string;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function NavigatorLoupe({
  cards,
  area,
  size,
  zoomSteps,
  zoomValue,
  onZoomChange,
  gridMode,
  onGridModeChange,
  onPanBy,
  orbSettings,
  onOrbChange,
  onOrbReset,
  tone,
  panKey,
}: {
  cards: MinimapCard[];
  /** The usable workspace in canvas px — the minimap's stable frame. */
  area: Rect;
  /** Loupe diameter (px). */
  size: number;
  zoomSteps: ReadonlyArray<{ label: number; value: number }>;
  zoomValue: number;
  onZoomChange: (value: number) => void;
  gridMode: boolean;
  onGridModeChange: (grid: boolean) => void;
  /** Roll the ball → pan the canvas view by (dx, dy) screen px. */
  onPanBy: (dx: number, dy: number) => void;
  /** Live refraction dials for the orb (driven by the tuner). */
  orbSettings: OrbSettings;
  onOrbChange: (patch: Partial<OrbSettings>) => void;
  onOrbReset: () => void;
  /** Current canvas tone — labels the tuner + scopes the saved dials. */
  tone: CanvasTone;
  /** Changes whenever the canvas is panned — wakes the auto-hidden loupe so the
   *  map reappears while you're navigating. */
  panKey: number;
}) {
  const rollRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);
  const [rolling, setRolling] = useState(false);
  const [tunerOpen, setTunerOpen] = useState(false);

  // The orb-tuner gear is hidden (admin-only). Open the tuner with ⌥⇧O, or via
  // the `o8:toggle-orb-tuner` window event (lets an operator/agent pop it open
  // without a visible control).
  useEffect(() => {
    const toggle = () => setTunerOpen((value) => !value);
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.shiftKey && event.code === 'KeyO') {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('o8:toggle-orb-tuner', toggle);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('o8:toggle-orb-tuner', toggle);
    };
  }, []);

  // ── Auto-hide: the loupe slides out of the way when idle and returns when
  // you navigate (pan/zoom), hover it, or reach for its corner. The operator
  // saw a canvas do this and liked it; it keeps the bottom-left clear while you
  // work without losing the map a flick away.
  const [revealed, setRevealed] = useState(true);
  const [hoveredRoot, setHoveredRoot] = useState(false);
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepAwakeRef = useRef(false);
  const reducedRef = useRef(false);

  // Reduced-motion: never auto-hide (no surprise motion). Set first so the
  // mount-time wake() below reads the right value.
  useEffect(() => {
    reducedRef.current = typeof window !== 'undefined'
      && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }, []);

  // Named function expression so the re-arm inside the timeout binds to `schedule`
  // itself (not the outer const), avoiding an access-before-declaration closure.
  const scheduleHide = useCallback(function schedule() {
    if (idleRef.current) clearTimeout(idleRef.current);
    if (reducedRef.current) return; // stay put under reduced motion
    idleRef.current = setTimeout(() => {
      // Don't vanish mid-interaction (hovering it, rolling, tuner open) — wait.
      if (keepAwakeRef.current) { schedule(); return; }
      setRevealed(false);
    }, HIDE_MS);
  }, []);
  const wake = useCallback(() => {
    setRevealed(true);
    scheduleHide();
  }, [scheduleHide]);

  useEffect(() => {
    keepAwakeRef.current = hoveredRoot || rolling || tunerOpen;
  }, [hoveredRoot, rolling, tunerOpen]);

  // Show on mount, then begin the idle countdown; and wake on any navigation
  // (zoom step or pan) so the map is there exactly when you're moving around.
  useEffect(() => { wake(); }, [wake, zoomValue, panKey]);

  // Reach toward the bottom-left corner → it slides back even when fully hidden.
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (event.clientX <= REVEAL_NEAR_PX && event.clientY >= window.innerHeight - REVEAL_NEAR_PX) {
        wake();
      }
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [wake]);

  useEffect(() => () => { if (idleRef.current) clearTimeout(idleRef.current); }, []);

  // Zoom steps run 100% (most zoomed-in) → 70% (most out). − steps out, + in.
  const idx = Math.max(0, zoomSteps.findIndex((s) => s.value === zoomValue));
  const stepZoom = (delta: number) => {
    const next = zoomSteps[Math.min(zoomSteps.length - 1, Math.max(0, idx + delta))];
    if (next) onZoomChange(next.value);
  };
  const atMin = idx >= zoomSteps.length - 1; // most zoomed out
  const atMax = idx <= 0; // most zoomed in

  return (
    <div
      onMouseEnter={() => { setHoveredRoot(true); wake(); }}
      onMouseLeave={() => { setHoveredRoot(false); scheduleHide(); }}
      style={{
        position: 'absolute',
        left: 16,
        bottom: 26,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        zIndex: 40,
        // Slide out of the way when idle; spring back on navigation/proximity.
        // translate down-left tucks the whole widget off the corner.
        transform: revealed ? 'translate(0, 0)' : 'translate(-122%, 46%)',
        opacity: revealed ? 1 : 0,
        pointerEvents: revealed ? 'auto' : 'none',
        transition: 'transform 460ms cubic-bezier(0.22, 1, 0.36, 1), opacity 300ms ease',
      }}
    >
      {/* Orb-refraction tuner — admin-only (⌥⇧O); opens upward, above the ball. */}
      <AnimatePresence>
        {tunerOpen ? (
          <OrbTuner settings={orbSettings} onChange={onOrbChange} onReset={onOrbReset} tone={tone} />
        ) : null}
      </AnimatePresence>

      {/* Crystal-ball navigator (#1239) — a glass sphere showing the cards near
          you, bent through a real lens. */}
      <div style={{ position: 'relative', width: size, height: size }}>
        <div
          aria-label="Canvas navigator"
          onPointerDown={gridMode ? undefined : (event) => {
            if (event.button !== 0) return;
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
            rollRef.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
            setRolling(true);
          }}
          onPointerMove={(event) => {
            const roll = rollRef.current;
            if (!roll || roll.pointerId !== event.pointerId) return;
            const dx = event.clientX - roll.lastX;
            const dy = event.clientY - roll.lastY;
            roll.lastX = event.clientX;
            roll.lastY = event.clientY;
            // Drag toward where you want to go → pan the view there.
            onPanBy(-dx * ROLL_SENS, -dy * ROLL_SENS);
          }}
          onPointerUp={() => { rollRef.current = null; setRolling(false); }}
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            overflow: 'hidden',
            // Clear glass — no painted body; the WebGL ball is see-through where
            // there's no card (Fog adds a milky fill back), so the canvas shows
            // through. A soft shadow keeps it sitting on the surface.
            background: 'transparent',
            boxShadow: '0 14px 34px rgba(0,0,0,0.20)',
            cursor: gridMode ? 'default' : rolling ? 'grabbing' : 'grab',
            touchAction: 'none',
          }}
        >
          {/* WebGL glass-sphere refraction (#1239) — the cards near you, bent
              onto the sphere surface: foreshortening toward the rim, specular,
              rim chroma. The outer div's transparent body shows the glass. */}
          <RefractionBall cards={cards} area={area} size={size} settings={orbSettings} />
        </div>

        {/* Bottom cluster — Free/Grid switch + −/fit/+ zoom in ONE row, overlapping
            the circle's lower edge (ref placement). */}
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: -10,
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            paddingTop: 3,
            paddingBottom: 3,
            paddingLeft: 5,
            paddingRight: 5,
            // Themed glass — follows the palette (dark glass + light ink in dark,
            // light glass + dark ink in light).
            ...glass(true),
            borderRadius: 999,
          }}
        >
          <ModeSwitch gridMode={gridMode} onChange={onGridModeChange} />
          <span aria-hidden style={{ width: 1, alignSelf: 'stretch', marginTop: 3, marginBottom: 3, background: 'var(--cnv-edge)' }} />
          <LoupeButton label="Zoom out" disabled={atMin} onClick={() => stepZoom(1)}>
            <line x1="5" y1="12" x2="19" y2="12" />
          </LoupeButton>
          <LoupeButton label="Fit to 100%" onClick={() => onZoomChange(zoomSteps[0]?.value ?? zoomValue)}>
            <path d="M8 4H5a1 1 0 0 0-1 1v3M16 4h3a1 1 0 0 1 1 1v3M8 20H5a1 1 0 0 1-1-1v-3M16 20h3a1 1 0 0 0 1-1v-3" />
          </LoupeButton>
          <LoupeButton label="Zoom in" disabled={atMax} onClick={() => stepZoom(-1)}>
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </LoupeButton>
        </div>
      </div>
    </div>
  );
}

/** Free ⟷ Grid — ONE toggle button: shows the current mode and flips to the
 *  other on click (a single control, not two). */
function ModeSwitch({ gridMode, onChange }: { gridMode: boolean; onChange: (grid: boolean) => void }) {
  return (
    <button
      type="button"
      aria-label={`Layout: ${gridMode ? 'Grid' : 'Free'}. Click to switch.`}
      aria-pressed={gridMode}
      onClick={() => onChange(!gridMode)}
      style={{
        borderWidth: 0,
        borderRadius: 7,
        background: 'rgba(255,255,255,0.12)',
        color: 'var(--cnv-ink)',
        fontSize: 9.5,
        fontWeight: 300,
        fontFamily: FONT,
        paddingTop: 4,
        paddingBottom: 4,
        paddingLeft: 10,
        paddingRight: 10,
        minWidth: 36,
        textAlign: 'center',
        cursor: 'pointer',
      }}
      onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.18)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
    >
      {gridMode ? 'Grid' : 'Free'}
    </button>
  );
}

function LoupeButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        borderWidth: 0,
        background: 'transparent',
        borderRadius: 7,
        width: 22,
        height: 20,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: disabled ? 'var(--cnv-ink-muted)' : 'var(--cnv-ink)',
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
      onMouseEnter={(event) => { if (!disabled) event.currentTarget.style.background = 'var(--cnv-edge)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
    >
      {/* flexShrink:0 + block — WebKit collapses an <svg> flex item to width:0 on
          the main axis inside an inline-flex button, which hid every icon. */}
      <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0, display: 'block' }}>
        {children}
      </svg>
    </button>
  );
}
