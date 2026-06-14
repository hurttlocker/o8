'use client';

/**
 * NavigatorLoupe (#1239) — the bottom-left canvas navigator that replaces the
 * zoom-level chip. A circular minimap of the canvas content with a −/fit/+ pill
 * and the Free/Grid mode toggle. Phase 1: minimap + zoom steps + mode toggle.
 * Phase 2 (needs the pan-offset refactor): drag-inside-to-pan + a viewport rect.
 *
 * Visual ref: operator screenshot — a small glass circle showing the cards as an
 * overview, a dark pill at its lower edge.
 */

import { useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { FONT, glass } from './ui';
import { RefractionBall } from './refraction-ball';
import { IconButton } from './icon-button';
import { OrbTuner } from './orb-tuner';
import type { CanvasTone, OrbSettings } from './orb-settings';

/** Roll sensitivity — drag the ball N screen-px → pan the view N×this. The ball
 *  is small but represents a big plane, so a drag travels further than the grab. */
const ROLL_SENS = 4.5;

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
}) {
  const rollRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);
  const [rolling, setRolling] = useState(false);
  const [tunerOpen, setTunerOpen] = useState(false);

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
      style={{
        position: 'absolute',
        left: 16,
        bottom: 26,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        zIndex: 40,
      }}
    >
      {/* Orb-refraction tuner — opens upward from the gear toggle (#1239). */}
      <AnimatePresence>
        {tunerOpen ? (
          <OrbTuner settings={orbSettings} onChange={onOrbChange} onReset={onOrbReset} tone={tone} />
        ) : null}
      </AnimatePresence>

      {/* Free / Grid mode toggle — lives on the navigator (#1239). */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          paddingTop: 3,
          paddingBottom: 3,
          paddingLeft: 6,
          paddingRight: 6,
          borderRadius: 11,
          ...glass(true),
        }}
      >
        {([['free', 'Free'], ['grid', 'Grid']] as const).map(([mode, label]) => {
          const active = (mode === 'grid') === gridMode;
          return (
            <button
              key={mode}
              type="button"
              aria-label={`${label} layout`}
              aria-pressed={active}
              onClick={() => onGridModeChange(mode === 'grid')}
              style={{
                borderWidth: 0,
                borderRadius: 8,
                background: active ? 'rgba(255,255,255,0.12)' : 'transparent',
                color: active ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
                fontSize: 9.5,
                fontWeight: 300,
                fontFamily: FONT,
                paddingTop: 3,
                paddingBottom: 3,
                paddingLeft: 8,
                paddingRight: 8,
                cursor: 'pointer',
              }}
              onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
              onMouseLeave={(event) => { if (!active) event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
            >
              {label}
            </button>
          );
        })}
        {/* Divider + reusable icon button → opens the orb refraction tuner. */}
        <span aria-hidden style={{ width: 1, alignSelf: 'stretch', marginTop: 2, marginBottom: 2, marginLeft: 3, marginRight: 1, background: 'var(--cnv-edge)' }} />
        <IconButton label="Tune orb refraction" active={tunerOpen} size={20} onClick={() => setTunerOpen((value) => !value)}>
          <line x1="21" x2="14" y1="4" y2="4" />
          <line x1="10" x2="3" y1="4" y2="4" />
          <line x1="21" x2="12" y1="12" y2="12" />
          <line x1="8" x2="3" y1="12" y2="12" />
          <line x1="21" x2="16" y1="20" y2="20" />
          <line x1="12" x2="3" y1="20" y2="20" />
          <line x1="14" x2="14" y1="2" y2="6" />
          <line x1="8" x2="8" y1="10" y2="14" />
          <line x1="16" x2="16" y1="18" y2="22" />
        </IconButton>
      </div>

      {/* Crystal-ball navigator (#1239) — a glass sphere showing the cards near
          you, with a refractive sheen + the roll-arc from the ref photo. */}
      <div style={{ position: 'relative', width: size, height: size }}>
        {/* (Roll-arc removed — the dashed indicator read as a skewed refraction
            seam crossing the content. The ball is still draggable to roll/pan.) */}
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
              through a real lens: magnified centre, chromatic aberration + a
              rainbow fringe at the rim, specular highlight, edge falloff. The
              outer div's radial-gradient shows through the transparent rim as
              the glass body. */}
          <RefractionBall cards={cards} area={area} size={size} settings={orbSettings} />
        </div>

        {/* −/fit/+ pill — overlaps the circle's lower edge (ref placement). */}
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: -10,
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            paddingTop: 3,
            paddingBottom: 3,
            paddingLeft: 4,
            paddingRight: 4,
            // Themed glass — same recipe as the Free/Grid toggle, so the pill
            // follows the palette (dark glass + light ink in dark, light glass +
            // dark ink in light) instead of a fixed dark control.
            ...glass(true),
            borderRadius: 999,
          }}
        >
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
