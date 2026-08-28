'use client';

import { useEffect, type MutableRefObject } from 'react';

// Shared ASCII-field engine. Handles the canvas, DPR, resize, RAF loop, cursor
// tracking, and the density→glyph render. An effect only supplies an `update`
// that writes intensities [0..1] into a flat grid (index = j*cols + i, row-major,
// top→bottom). This is what makes the lab cheap to extend: a new effect is a
// sample/update function plus a few props — see LiquidAscii for the one effect
// that owns its own loop (stateful FLIP physics) instead of using this.

export interface CursorState {
  x: number; // cell units, left→right
  y: number; // cell units, top→bottom
  vx: number; // cells per frame
  vy: number;
  inside: boolean;
  lastMoveMs: number;
}

export interface AsciiVisual {
  cellSize: number;
  characters: string;
  color: string;
  backgroundColor: string;
  fontFamily: string;
  opacity: number;
}

export interface AsciiEngine {
  /** Called on mount and every resize/reinit with the live grid dimensions. */
  init?(cols: number, rows: number): void;
  /** Fill `grid` (length cols*rows) with intensities in [0..1] for this frame. */
  update(grid: Float32Array, cols: number, rows: number, t: number, dt: number, cursor: CursorState): void;
}

export interface UseAsciiFieldOptions {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  engineRef: MutableRefObject<AsciiEngine | null>;
  visualRef: MutableRefObject<AsciiVisual>;
  /** Change this to force a re-measure + engine.init (e.g. cellSize, image src). */
  reinitKey: string;
}

export function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

// Cheap smooth value noise (no Perlin dep). Returns [0..1].
function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
export function noise2D(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  const u = smooth(xf);
  const v = smooth(yf);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
// Fractal noise — richer flow fields.
export function fbm(x: number, y: number, octaves = 3): number {
  let v = 0;
  let amp = 0.5;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    v += amp * noise2D(x * freq, y * freq);
    freq *= 2;
    amp *= 0.5;
  }
  return v;
}

export function useAsciiField(opts: UseAsciiFieldOptions): void {
  const { containerRef, canvasRef, engineRef, visualRef, reinitKey } = opts;

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let dpr = 1;
    let cssW = 0;
    let cssH = 0;
    let cols = 0;
    let rows = 0;
    let grid = new Float32Array(0);
    let cs = Math.max(4, visualRef.current.cellSize);

    const cursor: CursorState = { x: 0, y: 0, vx: 0, vy: 0, inside: false, lastMoveMs: -1e9 };
    let pcx = 0;
    let pcy = 0;
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

      cs = Math.max(4, visualRef.current.cellSize);
      cols = Math.max(8, Math.floor(cssW / cs));
      rows = Math.max(8, Math.floor(cssH / cs));
      grid = new Float32Array(cols * rows);
      engineRef.current?.init?.(cols, rows);
    }

    function onMove(e: PointerEvent) {
      const rect = container!.getBoundingClientRect();
      cursor.x = (e.clientX - rect.left) / cs;
      cursor.y = (e.clientY - rect.top) / cs;
      cursor.inside = true;
      cursor.lastMoveMs = now();
    }
    function onEnter(e: PointerEvent) {
      onMove(e);
      pcx = cursor.x;
      pcy = cursor.y;
    }
    function onLeave() {
      cursor.inside = false;
    }

    let raf = 0;
    let startMs = now();
    let lastMs = startMs;

    function frame() {
      const n = now();
      const dt = Math.min(0.05, (n - lastMs) / 1000);
      lastMs = n;
      const t = (n - startMs) / 1000;

      cursor.vx = cursor.x - pcx;
      cursor.vy = cursor.y - pcy;
      pcx = cursor.x;
      pcy = cursor.y;

      const engine = engineRef.current;
      if (engine) engine.update(grid, cols, rows, t, dt, cursor);

      const v = visualRef.current;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.fillStyle = v.backgroundColor;
      ctx!.fillRect(0, 0, cssW, cssH);
      ctx!.fillStyle = v.color;
      ctx!.font = `${cs}px ${v.fontFamily}`;
      ctx!.textBaseline = 'top';
      ctx!.textAlign = 'left';

      const chars = v.characters && v.characters.length > 1 ? v.characters : ' .:-=+*#%@';
      const last = chars.length - 1;
      for (let j = 0; j < rows; j++) {
        const y = j * cs;
        const rowOff = j * cols;
        for (let i = 0; i < cols; i++) {
          let val = grid[rowOff + i];
          if (val <= 0.02) continue;
          if (val > 1) val = 1;
          const idx = Math.round(val * last);
          if (idx <= 0) continue;
          const ch = chars[idx];
          if (ch === ' ') continue;
          ctx!.fillText(ch, i * cs, y);
        }
      }

      raf = requestAnimationFrame(frame);
    }

    build();
    startMs = now();
    lastMs = startMs;

    let resizeTimer = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const rect = container.getBoundingClientRect();
        if (Math.floor(rect.width) !== cssW || Math.floor(rect.height) !== cssH) build();
      }, 150);
    });
    ro.observe(container);
    container.addEventListener('pointermove', onMove);
    container.addEventListener('pointerenter', onEnter);
    container.addEventListener('pointerleave', onLeave);
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      ro.disconnect();
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerenter', onEnter);
      container.removeEventListener('pointerleave', onLeave);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reinitKey]);
}

export function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k in obj) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}
