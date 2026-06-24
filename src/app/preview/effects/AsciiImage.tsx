'use client';

import { useRef, type ReactNode } from 'react';
import { AsciiFieldView } from './AsciiFieldView';
import { clamp, stripUndefined, type AsciiEngine, type AsciiVisual } from './ascii-field';

// Draw a picture in ASCII. A source (text wordmark by default, or any image)
// is rasterized to the grid and sampled to luminance, then a diagonal "wave"
// of brightness washes across it and the cursor drags concentric ripples
// through it. The loading-screen / logo-reveal surface — feed it `o8`, your
// own text, or an uploaded image.

export interface AsciiImageProps {
  width?: string | number;
  height?: string | number;
  className?: string;
  children?: ReactNode;
  cellSize?: number;
  /** Text to render as ASCII (used when no imageSrc). */
  text?: string;
  /** Image URL/object-URL to render as ASCII (overrides text). */
  imageSrc?: string;
  /** How an image fits the grid. */
  fit?: 'contain' | 'cover';
  /** Invert luminance (for dark-on-light sources). */
  invert?: boolean;
  /** Reveal-wave speed (0–3). */
  speed?: number;
  /** Resting visibility of the picture under the wave (0–1). */
  baseLevel?: number;
  /** Brightness boost at the wave crest (0–2). */
  waveBoost?: number;
  /** Cursor ripple strength (0–100). */
  cursorRipple?: number;
  /** Cursor influence radius as fraction of the short side (0–0.5). */
  cursorRadius?: number;
  /** Contrast / gamma (0.5–3). */
  contrast?: number;
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
  text: 'o8',
  imageSrc: '',
  fit: 'contain' as 'contain' | 'cover',
  invert: false,
  speed: 1,
  baseLevel: 0.5,
  waveBoost: 0.85,
  cursorRipple: 40,
  cursorRadius: 0.25,
  contrast: 1.2,
  characters: ' .:-=+*#%@',
  color: '#ffffff',
  backgroundColor: '#000000',
  fontFamily: 'monospace',
  opacity: 1,
};

export function AsciiImage(props: AsciiImageProps) {
  const p = { ...DEFAULTS, ...stripUndefined(props) };
  const paramsRef = useRef(p);
  paramsRef.current = p;

  const visualRef = useRef<AsciiVisual>({
    cellSize: p.cellSize,
    characters: p.characters,
    color: p.color,
    backgroundColor: p.backgroundColor,
    fontFamily: p.fontFamily,
    opacity: p.opacity,
  });
  visualRef.current = {
    cellSize: p.cellSize,
    characters: p.characters,
    color: p.color,
    backgroundColor: p.backgroundColor,
    fontFamily: p.fontFamily,
    opacity: p.opacity,
  };

  const engineRef = useRef<AsciiEngine | null>(null);
  if (!engineRef.current) {
    let lum = new Float32Array(0);
    let ready = false;
    let token = 0;
    const off = typeof document !== 'undefined' ? document.createElement('canvas') : null;

    const sample = (octx: CanvasRenderingContext2D, cols: number, rows: number) => {
      const data = octx.getImageData(0, 0, cols, rows).data;
      const inv = paramsRef.current.invert;
      for (let k = 0; k < cols * rows; k++) {
        const r = data[4 * k];
        const g = data[4 * k + 1];
        const b = data[4 * k + 2];
        const a = data[4 * k + 3] / 255;
        const gray = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        lum[k] = (inv ? 1 - gray : gray) * a;
      }
    };

    const drawText = (octx: CanvasRenderingContext2D, cols: number, rows: number) => {
      octx.fillStyle = '#000';
      octx.fillRect(0, 0, cols, rows);
      const text = paramsRef.current.text || 'o8';
      octx.fillStyle = '#fff';
      octx.textBaseline = 'middle';
      octx.textAlign = 'center';
      let size = rows * 0.82;
      const font = (s: number) => `700 ${s}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
      octx.font = font(size);
      const w = octx.measureText(text).width;
      const maxW = cols * 0.86;
      const maxH = rows * 0.86;
      if (w > maxW) size *= maxW / w;
      if (size > maxH) size = maxH;
      octx.font = font(size);
      octx.fillText(text, cols / 2, rows / 2);
    };

    engineRef.current = {
      init(cols, rows) {
        lum = new Float32Array(cols * rows);
        ready = false;
        const myToken = ++token;
        if (!off) return;
        off.width = cols;
        off.height = rows;
        const octx = off.getContext('2d', { willReadFrequently: true });
        if (!octx) return;
        const src = paramsRef.current.imageSrc;
        if (src) {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            if (myToken !== token) return;
            octx.fillStyle = '#000';
            octx.fillRect(0, 0, cols, rows);
            const ir = img.width / img.height;
            const gr = cols / rows;
            let dw: number;
            let dh: number;
            const cover = paramsRef.current.fit === 'cover';
            if (cover ? ir > gr : ir < gr) {
              dh = rows;
              dw = rows * ir;
            } else {
              dw = cols;
              dh = cols / ir;
            }
            try {
              octx.drawImage(img, (cols - dw) / 2, (rows - dh) / 2, dw, dh);
              sample(octx, cols, rows);
              ready = true;
            } catch {
              ready = false;
            }
          };
          img.onerror = () => {
            if (myToken !== token) return;
            drawText(octx, cols, rows);
            sample(octx, cols, rows);
            ready = true;
          };
          img.src = src;
        } else {
          drawText(octx, cols, rows);
          sample(octx, cols, rows);
          ready = true;
        }
      },
      update(grid, cols, rows, t, _dt, cursor) {
        const q = paramsRef.current;
        if (!ready) {
          grid.fill(0);
          return;
        }
        const baseLevel = clamp(q.baseLevel, 0, 1);
        const boost = q.waveBoost;
        const sp = q.speed;
        const ripple = q.cursorRipple / 50;
        const rad = clamp(q.cursorRadius, 0.01, 0.5) * Math.min(cols, rows);
        const rad2 = 2 * rad * rad;
        const contrast = q.contrast;
        const span = cols + rows * 0.4;
        const edge = (t * sp * 0.25) % 1.4 * span;
        const bw2 = 2 * (cols * 0.1) * (cols * 0.1);

        for (let j = 0; j < rows; j++) {
          const rowOff = j * cols;
          for (let i = 0; i < cols; i++) {
            const base = lum[rowOff + i];
            if (base <= 0.015) {
              grid[rowOff + i] = 0;
              continue;
            }
            const dist = i + j * 0.4 - edge;
            const crest = Math.exp(-(dist * dist) / bw2);
            let val = base * (baseLevel + crest * boost);
            if (cursor.inside) {
              const dx = i - cursor.x;
              const dy = j - cursor.y;
              const d2 = dx * dx + dy * dy;
              if (d2 < rad2 * 3) {
                const d = Math.sqrt(d2);
                val += base * ripple * Math.exp(-d2 / rad2) * Math.sin(d * 0.7 - t * 7);
              }
            }
            grid[rowOff + i] = Math.pow(clamp(val, 0, 1), contrast);
          }
        }
      },
    };
  }

  return (
    <AsciiFieldView
      engineRef={engineRef}
      visualRef={visualRef}
      reinitKey={`${p.cellSize}|${p.text}|${p.imageSrc}|${p.fit}|${p.invert}`}
      width={p.width}
      height={p.height}
      opacity={p.opacity}
      className={p.className}
    >
      {props.children}
    </AsciiFieldView>
  );
}

export default AsciiImage;
