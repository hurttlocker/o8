'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AsciiFieldView } from './AsciiFieldView';
import { clamp, fbm, stripUndefined, type AsciiEngine, type AsciiVisual } from './ascii-field';

// Flowing interference waves rendered to ASCII. Layered traveling sines + a
// little fbm drift give an organic ocean/plasma surface; the cursor drags a
// radial ripple wake through it. Great as an ambient background or loading veil.

export interface AsciiWaveFieldProps {
  width?: string | number;
  height?: string | number;
  className?: string;
  children?: ReactNode;
  /** Character cell size in pixels (6–30). */
  cellSize?: number;
  /** Animation speed (0.1–3). */
  speed?: number;
  /** Spatial zoom of the wave pattern (0.3–3). */
  waveScale?: number;
  /** Octaves of fbm texture layered on the waves (1–5). */
  complexity?: number;
  /** Contrast / gamma applied to the field (0.5–3). */
  contrast?: number;
  /** Cursor ripple strength (0–100). */
  cursorWake?: number;
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
  speed: 1,
  waveScale: 1,
  complexity: 3,
  contrast: 1.5,
  cursorWake: 45,
  cursorRadius: 0.28,
  characters: ' .:-=+*#%@',
  color: '#ffffff',
  backgroundColor: '#000000',
  fontFamily: 'monospace',
  opacity: 1,
};

export function AsciiWaveField(props: AsciiWaveFieldProps) {
  const p = { ...DEFAULTS, ...stripUndefined(props) };
  const paramsRef = useRef(p);

  const visualRef = useRef<AsciiVisual>({
    cellSize: props.cellSize ?? 13,
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
      cellSize: props.cellSize ?? 13,
      characters: next.characters,
      color: next.color,
      backgroundColor: next.backgroundColor,
      fontFamily: next.fontFamily,
      opacity: next.opacity,
    };
  }, [props]);

  const [engine] = useState<AsciiEngine>(() => ({
      update(grid, cols, rows, t, _dt, cursor) {
        const q = paramsRef.current;
        const sp = q.speed;
        const sc = q.waveScale;
        const oct = Math.round(clamp(q.complexity, 1, 5));
        const contrast = q.contrast;
        const wake = q.cursorWake / 50;
        const rad = clamp(q.cursorRadius, 0.01, 0.5) * Math.min(cols, rows);
        const rad2 = 2 * rad * rad;
        const speedMag = Math.min(2, Math.hypot(cursor.vx, cursor.vy));

        for (let j = 0; j < rows; j++) {
          const fy = j / rows;
          const off = j * cols;
          for (let i = 0; i < cols; i++) {
            const fx = i / cols;
            let v =
              Math.sin(fx * 6.2 * sc + t * sp) +
              Math.sin(fy * 5.0 * sc - t * sp * 0.7) +
              Math.sin((fx + fy) * 4.0 * sc + t * sp * 0.5) +
              Math.sin(Math.hypot(fx - 0.5, fy - 0.5) * 12 * sc - t * sp * 1.3);
            v /= 4;
            v += (fbm(fx * 3 * sc + t * 0.12, fy * 3 * sc - t * 0.1, oct) - 0.5) * 0.85;
            let val = (v + 1) / 2;

            if (cursor.inside) {
              const dx = i - cursor.x;
              const dy = j - cursor.y;
              const d2 = dx * dx + dy * dy;
              if (d2 < rad2 * 3) {
                const d = Math.sqrt(d2);
                val += wake * Math.exp(-d2 / rad2) * Math.sin(d * 0.6 - t * 6) * (0.5 + speedMag * 0.4);
              }
            }

            grid[off + i] = Math.pow(clamp(val, 0, 1), contrast);
          }
        }
      },
    }));
  const engineRef = useRef<AsciiEngine | null>(engine);

  return (
    <AsciiFieldView
      engineRef={engineRef}
      visualRef={visualRef}
      reinitKey={String(props.cellSize ?? 13)}
      width={p.width}
      height={p.height}
      opacity={p.opacity}
      className={p.className}
    >
      {props.children}
    </AsciiFieldView>
  );
}

export default AsciiWaveField;
