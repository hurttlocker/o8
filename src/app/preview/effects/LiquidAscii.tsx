'use client';

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { FlipFluid } from './flip-fluid';

// 1:1 recreation of the ReactBits "Liquid ASCII" effect — a FLIP/PIC fluid
// (see ./flip-fluid.ts) rendered to a grid of ASCII glyphs whose weight tracks
// local fluid density. The cursor is a moving obstacle; when idle, gentle waves
// keep the surface alive. Reusable as a background or loading screen.

export interface LiquidAsciiProps {
  width?: string | number;
  height?: string | number;
  className?: string;
  children?: ReactNode;
  /** Simulation timestep multiplier (0.1–3). */
  speed?: number;
  /** Character cell size in pixels (6–30). */
  cellSize?: number;
  /** Gravity strength (negative = downward, 0 = zero-g) (-50–0). */
  gravity?: number;
  /** FLIP vs PIC blending ratio (0 = PIC, 1 = FLIP). */
  flipRatio?: number;
  /** Pressure solver iterations (5–80). */
  pressureIters?: number;
  /** Particle separation passes (1–10). */
  separationIters?: number;
  /** Over-relaxation factor for the pressure solve (1–2). */
  overRelaxation?: number;
  /** Fill fraction of the tank (0–1). */
  fillHeight?: number;
  /** Radius of mouse influence as fraction of the short side (0–0.5). */
  cursorRadius?: number;
  /** Strength of cursor push force (0–200). */
  cursorForce?: number;
  /** Characters ordered by visual weight (light to heavy). */
  characters?: string;
  /** Text color (hex). */
  color?: string;
  /** Background color (hex). */
  backgroundColor?: string;
  /** Font family for rendering. */
  fontFamily?: string;
  /** Master opacity (0–1). */
  opacity?: number;
  /** Auto-animate waves when the cursor is idle. */
  autoWave?: boolean;
}

const DEFAULTS = {
  width: '100%' as string | number,
  height: '100%' as string | number,
  speed: 0.9,
  cellSize: 15,
  gravity: -25,
  flipRatio: 0.3,
  pressureIters: 30,
  separationIters: 3,
  overRelaxation: 1.5,
  fillHeight: 0.4,
  cursorRadius: 0.25,
  cursorForce: 66,
  characters: ' ·:-~=+*#%@',
  color: '#ffffff',
  backgroundColor: '#000000',
  fontFamily: 'monospace',
  opacity: 1,
  autoWave: true,
};

const PARTICLE_RADIUS = 0.3; // in cell units (h = 1)
const IDLE_MS = 1100; // cursor still for this long -> auto-wave takes over
const BASE_DT = 1 / 60;

export function LiquidAscii(props: LiquidAsciiProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Live params — read by the RAF loop every frame so slider tweaks apply
  // instantly without rebuilding the fluid.
  const paramsRef = useRef({ ...DEFAULTS, ...stripUndefined(props) });
  paramsRef.current = { ...DEFAULTS, ...stripUndefined(props) };

  // Structural props that require a re-seed of the simulation.
  const cellSize = props.cellSize ?? DEFAULTS.cellSize;
  const fillHeight = props.fillHeight ?? DEFAULTS.fillHeight;

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let fluid: FlipFluid | null = null;
    let dpr = 1;
    let cssW = 0;
    let cssH = 0;

    // Cursor / obstacle state (sim coordinates).
    let cursorX = 0;
    let cursorY = 0;
    let pointerInside = false;
    let lastMoveMs = -1e9;
    let prevObsX = 0;
    let prevObsY = 0;
    let obsPrimed = false;

    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

    function build() {
      const rect = container!.getBoundingClientRect();
      cssW = Math.max(1, Math.floor(rect.width));
      cssH = Math.max(1, Math.floor(rect.height));
      dpr = Math.min(window.devicePixelRatio || 1, 2);

      canvas!.width = Math.floor(cssW * dpr);
      canvas!.height = Math.floor(cssH * dpr);
      canvas!.style.width = `${cssW}px`;
      canvas!.style.height = `${cssH}px`;

      const cs = Math.max(4, paramsRef.current.cellSize);
      const cols = Math.max(8, Math.floor(cssW / cs));
      const rows = Math.max(8, Math.floor(cssH / cs));

      // Estimate max particles for a full hex pack so the buffer never overflows.
      const r = PARTICLE_RADIUS;
      const dx = 2 * r;
      const dy = (Math.sqrt(3) / 2) * dx;
      const maxParticles = Math.ceil(((cols + 2) / dx) * ((rows + 2) / dy)) + 64;

      fluid = new FlipFluid(cols, rows, r, maxParticles);
      fluid.seedParticles(paramsRef.current.fillHeight);
      obsPrimed = false;
    }

    function screenToSim(clientX: number, clientY: number) {
      const rect = container!.getBoundingClientRect();
      const cs = Math.max(4, paramsRef.current.cellSize);
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      cursorX = mx / cs;
      cursorY = (fluid ? fluid.fNumY : rows0()) - my / cs;
    }
    function rows0() {
      return Math.max(8, Math.floor(cssH / Math.max(4, paramsRef.current.cellSize)));
    }

    function onPointerMove(e: PointerEvent) {
      pointerInside = true;
      lastMoveMs = now();
      screenToSim(e.clientX, e.clientY);
    }
    function onPointerEnter(e: PointerEvent) {
      pointerInside = true;
      lastMoveMs = now();
      screenToSim(e.clientX, e.clientY);
      obsPrimed = false; // avoid a velocity spike on entry
    }
    function onPointerLeave() {
      pointerInside = false;
      obsPrimed = false;
    }

    function step() {
      if (!fluid) return;
      const p = paramsRef.current;

      const totalDt = BASE_DT * clamp(p.speed, 0.1, 3);
      const numSub = Math.max(1, Math.ceil(totalDt / BASE_DT));
      const sdt = totalDt / numSub;

      const shortSide = Math.min(fluid.fNumX, fluid.fNumY);
      const obstacleRadius = clamp(p.cursorRadius, 0, 0.5) * shortSide;
      const idle = now() - lastMoveMs > IDLE_MS;

      // Resolve the obstacle (cursor, or an idle auto-wave sweep).
      let ox = prevObsX;
      let oy = prevObsY;
      let active = false;
      let autoMode = false;
      let radius = obstacleRadius;

      if (pointerInside && !idle) {
        ox = cursorX;
        oy = cursorY;
        active = true;
      } else if (p.autoWave) {
        // A slow obstacle skimming the surface — gentle traveling waves, not a shove.
        const t = now() / 1000;
        const surface = clamp(p.fillHeight, 0.05, 1) * fluid.fNumY;
        ox = fluid.fNumX * (0.5 + 0.32 * Math.sin(t * 0.55));
        oy = surface * (0.92 + 0.1 * Math.sin(t * 0.9 + 1.1));
        radius = obstacleRadius * 0.55;
        active = true;
        autoMode = true;
      }

      const forceScale = (p.cursorForce / 66) * (autoMode ? 0.45 : 1);
      let ovx = 0;
      let ovy = 0;
      if (active) {
        if (!obsPrimed) {
          prevObsX = ox;
          prevObsY = oy;
          obsPrimed = true;
        }
        ovx = clamp(((ox - prevObsX) / totalDt) * forceScale, -shortSide * 4, shortSide * 4);
        ovy = clamp(((oy - prevObsY) / totalDt) * forceScale, -shortSide * 4, shortSide * 4);
        prevObsX = ox;
        prevObsY = oy;
      } else {
        obsPrimed = false;
      }

      const separate = p.separationIters > 0;
      for (let s = 0; s < numSub; s++) {
        fluid.clearObstacleSolids();
        fluid.setObstacle(ox, oy, ovx, ovy, radius, active);
        fluid.simulate(
          sdt,
          p.gravity,
          clamp(p.flipRatio, 0, 1),
          Math.round(clamp(p.pressureIters, 1, 80)),
          Math.round(clamp(p.separationIters, 1, 10)),
          clamp(p.overRelaxation, 1, 2),
          true,
          separate,
        );
      }
    }

    function render() {
      if (!fluid || !ctx) return;
      const p = paramsRef.current;
      const cs = Math.max(4, p.cellSize);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = p.backgroundColor;
      ctx.fillRect(0, 0, cssW, cssH);

      ctx.fillStyle = p.color;
      ctx.font = `${cs}px ${p.fontFamily}`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';

      const chars = p.characters && p.characters.length > 1 ? p.characters : DEFAULTS.characters;
      const last = chars.length - 1;
      const rest = fluid.particleRestDensity > 0 ? fluid.particleRestDensity : 1;
      const n = fluid.fNumY;
      const density = fluid.particleDensity;

      for (let j = 0; j < fluid.fNumY; j++) {
        const y = (fluid.fNumY - 1 - j) * cs;
        for (let i = 0; i < fluid.fNumX; i++) {
          let ratio = density[i * n + j] / rest;
          if (ratio <= 0.04) continue;
          if (ratio > 1) ratio = 1;
          const idx = Math.round(ratio * last);
          if (idx <= 0) continue;
          const ch = chars[idx];
          if (ch === ' ') continue;
          ctx.fillText(ch, i * cs, y);
        }
      }
    }

    let raf = 0;
    function frame() {
      step();
      render();
      raf = requestAnimationFrame(frame);
    }

    build();

    // Re-seed only on size changes (debounced); cellSize/fillHeight changes
    // re-run the whole effect via the dep array below.
    let resizeTimer = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const rect = container.getBoundingClientRect();
        if (Math.floor(rect.width) !== cssW || Math.floor(rect.height) !== cssH) build();
      }, 150);
    });
    ro.observe(container);

    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerenter', onPointerEnter);
    container.addEventListener('pointerleave', onPointerLeave);

    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      ro.disconnect();
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerenter', onPointerEnter);
      container.removeEventListener('pointerleave', onPointerLeave);
    };

  }, [cellSize, fillHeight]);

  const width = props.width ?? DEFAULTS.width;
  const height = props.height ?? DEFAULTS.height;
  const opacity = props.opacity ?? DEFAULTS.opacity;

  const containerStyle: CSSProperties = {
    position: 'relative',
    width: typeof width === 'number' ? `${width}px` : width,
    height: typeof height === 'number' ? `${height}px` : height,
    overflow: 'hidden',
  };
  const canvasStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    display: 'block',
    opacity,
    touchAction: 'none',
  };

  return (
    <div ref={containerRef} className={props.className} style={containerStyle}>
      <canvas ref={canvasRef} style={canvasStyle} aria-hidden />
      {props.children != null && (
        <div style={{ position: 'relative', zIndex: 1, width: '100%', height: '100%' }}>{props.children}</div>
      )}
    </div>
  );
}

function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k in obj) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

export default LiquidAscii;
