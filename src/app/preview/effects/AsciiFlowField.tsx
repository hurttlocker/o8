'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AsciiFieldView } from './AsciiFieldView';
import { clamp, fbm, stripUndefined, type AsciiEngine, type AsciiVisual } from './ascii-field';

// Particles drift along an fbm flow field, splatting into a fading grid so each
// leaves a trailing streak — an aurora / data-stream feel. The cursor pushes
// particles outward. Premium ambient hero background or idle/loading surface.

export interface AsciiFlowFieldProps {
  width?: string | number;
  height?: string | number;
  className?: string;
  children?: ReactNode;
  cellSize?: number;
  /** Particle speed (0.1–2). */
  speed?: number;
  /** Particle count as a fraction of grid cells (0.05–1). */
  density?: number;
  /** Trail persistence — higher = longer streaks (0–0.98). */
  trail?: number;
  /** Spatial scale of the flow field (0.3–3). */
  flowScale?: number;
  /** Turbulence multiplier on the flow angle (0.2–3). */
  swirl?: number;
  /** Cursor push strength (0–100). */
  cursorForce?: number;
  /** Cursor influence radius as fraction of the short side (0–0.5). */
  cursorRadius?: number;
  characters?: string;
  color?: string;
  backgroundColor?: string;
  fontFamily?: string;
  opacity?: number;
}

const DEFAULTS = {
  width: '100%' as string | number,
  height: '100%' as string | number,
  cellSize: 12,
  speed: 0.6,
  density: 0.5,
  trail: 0.86,
  flowScale: 1,
  swirl: 1,
  cursorForce: 32,
  cursorRadius: 0.2,
  characters: ' .:-=+*#%@',
  color: '#ffffff',
  backgroundColor: '#000000',
  fontFamily: 'monospace',
  opacity: 1,
};

const MAX_PARTICLES = 6000;
const BRIGHTNESS = 0.55;

export function AsciiFlowField(props: AsciiFlowFieldProps) {
  const p = { ...DEFAULTS, ...stripUndefined(props) };
  const paramsRef = useRef(p);

  const visualRef = useRef<AsciiVisual>({
    cellSize: p.cellSize,
    characters: p.characters,
    color: p.color,
    backgroundColor: p.backgroundColor,
    fontFamily: p.fontFamily,
    opacity: p.opacity,
  });
  useLayoutEffect(() => {
    const next = { ...DEFAULTS, ...stripUndefined(props) };
    paramsRef.current = next;
    visualRef.current = {
      cellSize: next.cellSize,
      characters: next.characters,
      color: next.color,
      backgroundColor: next.backgroundColor,
      fontFamily: next.fontFamily,
      opacity: next.opacity,
    };
  }, [props]);

  const [engine] = useState<AsciiEngine>(() => {
    let particles = new Float32Array(0);
    let n = 0;
    return {
      init(cols, rows) {
        n = Math.min(MAX_PARTICLES, Math.round(cols * rows * clamp(paramsRef.current.density, 0.05, 1)));
        particles = new Float32Array(n * 2);
        for (let k = 0; k < n; k++) {
          particles[2 * k] = Math.random() * cols;
          particles[2 * k + 1] = Math.random() * rows;
        }
      },
      update(grid, cols, rows, t, _dt, cursor) {
        const q = paramsRef.current;
        const fade = clamp(q.trail, 0, 0.98);
        for (let k = 0; k < grid.length; k++) grid[k] *= fade;

        const fs = q.flowScale * 0.06;
        const sw = q.swirl;
        const sp = q.speed;
        const force = q.cursorForce / 9;
        const rad = clamp(q.cursorRadius, 0.01, 0.5) * Math.min(cols, rows);
        const rad2 = rad * rad;

        for (let k = 0; k < n; k++) {
          let px = particles[2 * k];
          let py = particles[2 * k + 1];

          const a = fbm(px * fs + t * 0.05, py * fs - t * 0.04, 3) * Math.PI * 2 * sw;
          let vx = Math.cos(a) * sp;
          let vy = Math.sin(a) * sp;

          if (cursor.inside) {
            const dx = px - cursor.x;
            const dy = py - cursor.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < rad2 && d2 > 0.0001) {
              const d = Math.sqrt(d2);
              const f = (force * (1 - d / rad)) / d;
              vx += dx * f;
              vy += dy * f;
            }
          }

          px += vx;
          py += vy;
          if (px < 0) px += cols;
          else if (px >= cols) px -= cols;
          if (py < 0) py += rows;
          else if (py >= rows) py -= rows;
          particles[2 * k] = px;
          particles[2 * k + 1] = py;

          const ci = px | 0;
          const cj = py | 0;
          if (ci >= 0 && ci < cols && cj >= 0 && cj < rows) {
            const idx = cj * cols + ci;
            const nv = grid[idx] + BRIGHTNESS;
            grid[idx] = nv > 1 ? 1 : nv;
          }
        }
      },
    };
  });
  const engineRef = useRef<AsciiEngine | null>(engine);

  return (
    <AsciiFieldView
      engineRef={engineRef}
      visualRef={visualRef}
      reinitKey={`${p.cellSize}|${p.density}`}
      width={p.width}
      height={p.height}
      opacity={p.opacity}
      className={p.className}
    >
      {props.children}
    </AsciiFieldView>
  );
}

export default AsciiFlowField;
