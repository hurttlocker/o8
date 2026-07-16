'use client';

/**
 * WorkspaceBootLoader — the calm boot loader shown while a workspace surface is
 * resolving: OrchestratorTab rehydrating its last thread, or the workspace panel
 * still figuring out its tabs (the boot window before the "Start a new session"
 * CTA is allowed to show).
 *
 * It paints the SAME ASCII "o8" wave as the app's boot splash
 * (scripts/tauri-export.mjs) so boot → workspace reads as one continuous
 * identity. Unlike the bundled boot splash (which can't see the app theme and is
 * hardcoded), this one runs inside the app, so it reads the live theme tokens
 * (--t-chat-surface-bg / --t-text) off :root — light glyphs on dark, dark glyphs
 * on light. A wordmark is rasterized to the grid, sampled to a density ramp, and
 * a diagonal crest washes across it.
 */

import { memo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const RAMP = ' .:-=+*#%@';
const CELL = 6;
const SCALE = 0.4;
const TEXT = 'o8';

function readVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function WorkspaceBootLoaderBase() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Theme-aware: read the resolved surface + ink tokens once on mount. In
    // glass surface the overlay carries the boot splash's translucent tint
    // (set on the wrapper below), so the canvas CLEARS instead of painting an
    // opaque slab and the ink goes white — identical to the bundled splash.
    const glass = document.documentElement.dataset.surface === 'glass';
    const bg = readVar('--t-chat-surface-bg', '#0a0a0a');
    const ink = glass ? '#ffffff' : readVar('--t-text', '#f4f4f5');

    let dpr = 1;
    let cssW = 0;
    let cssH = 0;
    let cols = 0;
    let rows = 0;
    let lum = new Float32Array(0);
    let cx = -1;
    let cy = -1;
    const off = document.createElement('canvas');
    const onPointerMove = (e: PointerEvent) => { cx = e.clientX / CELL; cy = e.clientY / CELL; };
    const onPointerLeave = () => { cx = -1; cy = -1; };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerleave', onPointerLeave);

    function build() {
      const rect = canvas!.getBoundingClientRect();
      cssW = Math.max(1, Math.floor(rect.width));
      cssH = Math.max(1, Math.floor(rect.height));
      dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas!.width = Math.floor(cssW * dpr);
      canvas!.height = Math.floor(cssH * dpr);
      cols = Math.max(8, Math.floor(cssW / CELL));
      rows = Math.max(8, Math.floor(cssH / CELL));
      lum = new Float32Array(cols * rows);

      off.width = cols;
      off.height = rows;
      const o = off.getContext('2d', { willReadFrequently: true });
      if (!o) return;
      o.fillStyle = '#000';
      o.fillRect(0, 0, cols, rows);
      o.fillStyle = '#fff';
      o.textBaseline = 'middle';
      o.textAlign = 'center';
      let size = rows * SCALE;
      const font = (s: number) => `700 ${s}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
      o.font = font(size);
      const w = o.measureText(TEXT).width;
      const maxW = cols * 0.86;
      const maxH = rows * 0.86;
      if (w > maxW) size *= maxW / w;
      if (size > maxH) size = maxH;
      o.font = font(size);
      o.fillText(TEXT, cols / 2, rows / 2);
      const d = o.getImageData(0, 0, cols, rows).data;
      for (let k = 0; k < cols * rows; k++) {
        const a = d[4 * k + 3] / 255;
        lum[k] = ((0.299 * d[4 * k] + 0.587 * d[4 * k + 1] + 0.114 * d[4 * k + 2]) / 255) * a;
      }
    }

    build();
    const ro = new ResizeObserver(() => build());
    ro.observe(canvas);

    const last = RAMP.length - 1;
    let raf = 0;
    let start = 0;
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

    function frame(ts: number) {
      if (!start) start = ts;
      const t = (ts - start) / 1000;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (glass) {
        // Transparent canvas — the wrapper's glass tint (and the vibrancy
        // beneath the transparent chrome) reads through between glyphs.
        ctx!.clearRect(0, 0, cssW, cssH);
      } else {
        ctx!.fillStyle = bg;
        ctx!.fillRect(0, 0, cssW, cssH);
      }
      ctx!.fillStyle = ink;
      ctx!.font = `${CELL}px ui-monospace, Menlo, monospace`;
      ctx!.textBaseline = 'top';
      ctx!.textAlign = 'left';

      const span = cols + rows * 0.4;
      const edge = ((t * 0.25) % 1.4) * span;
      const bw2 = 2 * (cols * 0.1) * (cols * 0.1);
      // Pointer ripple — same recipe as the bundled boot splash (ripple 0.66,
      // radiusFrac 0.04) so the two loaders read as one continuous surface.
      const rad = 0.04 * Math.min(cols, rows);
      const rad2 = 2 * rad * rad;
      const inside = cx >= 0;

      for (let j = 0; j < rows; j++) {
        const y = j * CELL;
        const rowOff = j * cols;
        for (let i = 0; i < cols; i++) {
          const base = lum[rowOff + i];
          if (base <= 0.015) continue;
          const dist = i + j * 0.4 - edge;
          const crest = Math.exp(-(dist * dist) / bw2);
          let val = base * (0.5 + crest * 0.85);
          if (inside) {
            const dx = i - cx;
            const dy = j - cy;
            const d2 = dx * dx + dy * dy;
            if (d2 < rad2 * 3) {
              val += base * (33 / 50) * Math.exp(-d2 / rad2) * Math.sin(Math.sqrt(d2) * 0.7 - t * 7);
            }
          }
          if (val <= 0.02) continue;
          if (val > 1) val = 1;
          const idx = Math.round(Math.pow(val, 1.2) * last);
          if (idx <= 0) continue;
          const ch = RAMP[idx];
          if (ch === ' ') continue;
          ctx!.fillText(ch, i * CELL, y);
        }
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    start = now();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
    };
  }, []);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 180,
        // OPAQUE in both surfaces (Q ruling 2026-07-16): the old glass tint
        // (alpha ~0.6, borrowed from the bundled splash) let the mounted
        // chrome + the solid center tile read THROUGH the loader — the
        // "half-and-half" boot (sidebar and status bar up, bright grey slab
        // over the workspace). The splash's translucency only worked because
        // nothing but vibrancy sat behind it. Same tones, alpha 1: one cover,
        // one reveal when the workspace is actually ready.
        background: document.documentElement.dataset.surface === 'glass'
          ? 'linear-gradient(180deg, rgb(32, 36, 42) 0%, rgb(18, 20, 24) 100%)'
          : 'var(--t-chat-surface-bg)',
        animation: 'o8BootBackdropIn 200ms ease-out both',
      }}
      aria-label="Loading workspace"
      aria-live="polite"
    >
      <style>{`
        @keyframes o8BootBackdropIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes o8BootCaptionIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} aria-hidden />
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: '14%',
          textAlign: 'center',
          fontSize: 11.5,
          fontWeight: 320,
          letterSpacing: '0.04em',
          color: 'var(--t-text-faint)',
          fontFamily: 'var(--font-sans-system)',
          animation: 'o8BootCaptionIn 600ms ease-out both',
        }}
      >
        Loading workspace…
      </div>
    </div>,
    document.body,
  );
}

export const WorkspaceBootLoader = memo(WorkspaceBootLoaderBase);
