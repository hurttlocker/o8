'use client';

/**
 * /spatial-ink — Symon Spatial Context: draw-on-screen voice context.
 *
 * The body of the transparent, all-spaces Tauri window labeled `spatial-ink`
 * (NEVER `main` — see the label-discipline note in
 * `src-tauri/src/spatial_ink_window.rs`). Rust creates the window at boot, sizes
 * it to the cursor's monitor + CAPTURES the mouse only during an agent hold
 * (arm/disarm), and applies the transparent / level-24 / nonactivating recipe.
 * This page only has to:
 *
 *   1. Latch on an AGENT-lane hold: `o8:stt-event` `system-start` with
 *      `lane:'agent'` arms drawing; terminal types (`system-idle` / `error` /
 *      `system-pasted`) tear it down. Also clears on Rust's `o8:spatial-ink-clear`
 *      (fired by disarm). Same latch as agent-partials.
 *   2. Paint ember-orange comet-trail strokes on a full-viewport 2D canvas from
 *      pointer events (coalesced for smoothness), holding while the key is held.
 *   3. Emit `o8:spatial-ink-first-stroke` on the first stroke (Rust captures the
 *      screen then) and `o8:spatial-ink-strokes` on the `final` event (Rust has
 *      the strokes at finalize), plus `o8:spatial-ink-disarm-request` on any
 *      terminal event (belt for the mouse-capture safety chain).
 *
 * Coordinates are emitted NORMALIZED (0..1) so they survive the capture-vs-window
 * resolution mismatch. Inline styles only (repo rule); no emoji.
 */

import { useEffect, useRef } from 'react';
import { isTauri } from '@/lib/tauri/bridge';

export const dynamic = 'force-dynamic';

// Ember-orange = --t-brand-orange (#FF5A1F). Matches the Symon Points overlay
// vocabulary so the operator's marks and Symon's point-backs are one language.
const ORANGE = '#FF5A1F';
const CORE_HOT = '#FFE2CF'; // warm-white hot core over the glow

// Terminal STT types that always tear the ink down, regardless of lane.
const TERMINAL = new Set(['system-idle', 'error', 'system-pasted']);

// Snapshot flash (brightness swell) then fade after handoff — the send "feels"
// captured. Strokes HOLD (no auto-fade) until then, so a big circle survives a
// long thought (the reference demo's one jank, fixed).
const FLASH_MS = 200;
const FADE_MS = 600;

interface InkPoint {
  x: number; // CSS px
  y: number;
  t: number; // ms since stroke start
}
interface Stroke {
  pts: InkPoint[];
  done: boolean;
}
type Phase = 'idle' | 'live' | 'flash' | 'fade';

interface SttPayload {
  type?: string;
  origin?: string;
  lane?: string;
  sessionId?: number;
}

export default function SpatialInkPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentRef = useRef<Stroke | null>(null);
  const drawingRef = useRef(false);
  const activeRef = useRef(false);
  const sessionIdRef = useRef<number | null>(null);
  const firstStrokeEmittedRef = useRef(false);
  const handedOffRef = useRef(false);
  const phaseRef = useRef<Phase>('idle');
  const phaseStartRef = useRef(0);
  const strokeStartRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const emitRef = useRef<((event: string, payload: unknown) => void) | null>(null);
  const dprRef = useRef(1);
  const reducedRef = useRef(false);

  // The OS-level window is transparent; html/body must not paint a background or
  // the whole monitor shows an opaque rectangle instead of just the strokes.
  useEffect(() => {
    const prevHtml = document.documentElement.style.background;
    const prevBody = document.body.style.background;
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    return () => {
      document.documentElement.style.background = prevHtml;
      document.body.style.background = prevBody;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    reducedRef.current =
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // ── Canvas sizing (device-pixel-aware) ──
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      dprRef.current = dpr;
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    };
    resize();
    window.addEventListener('resize', resize);

    // ── Render loop ──
    const clearAll = () => {
      strokesRef.current = [];
      currentRef.current = null;
      drawingRef.current = false;
      phaseRef.current = 'idle';
      const dpr = dprRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };

    const drawStroke = (stroke: Stroke, alpha: number, glow: number, isHead: boolean) => {
      const pts = stroke.pts;
      if (pts.length === 0) return;
      const reduced = reducedRef.current;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (pts.length === 1) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = ORANGE;
        if (!reduced) {
          ctx.shadowColor = ORANGE;
          ctx.shadowBlur = 12 * glow;
        }
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        return;
      }

      // Glow + taper pass: thin tail → thick head (comet trail).
      ctx.strokeStyle = ORANGE;
      if (!reduced) ctx.shadowColor = ORANGE;
      const n = pts.length;
      for (let i = 1; i < n; i++) {
        const f = i / (n - 1); // 0 tail .. 1 head
        ctx.beginPath();
        ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
        ctx.lineTo(pts[i].x, pts[i].y);
        ctx.lineWidth = reduced ? 3 : 1.4 + f * 2.4;
        ctx.globalAlpha = reduced ? alpha : alpha * (0.55 + 0.45 * f);
        ctx.shadowBlur = reduced ? 0 : 11 * glow;
        ctx.stroke();
      }

      // Hot core — thin, bright, no shadow, over the glow.
      ctx.shadowBlur = 0;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = reduced ? ORANGE : CORE_HOT;
      ctx.lineWidth = reduced ? 3 : 1.5;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();

      // Live head pulse — a bright breathing dot at the leading point.
      if (isHead && !reduced && phaseRef.current === 'live') {
        const head = pts[n - 1];
        const pulse = 4 + Math.sin(performance.now() / 130) * 1.6;
        const grad = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, pulse + 6);
        grad.addColorStop(0, 'rgba(255,240,225,0.95)');
        grad.addColorStop(0.4, 'rgba(255,110,45,0.7)');
        grad.addColorStop(1, 'rgba(255,90,31,0)');
        ctx.globalAlpha = alpha;
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(head.x, head.y, pulse + 6, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const frame = () => {
      rafRef.current = null;
      const dpr = dprRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, window.innerWidth + 2, window.innerHeight + 2);

      const phase = phaseRef.current;
      const now = performance.now();
      let alpha = 1;
      let glow = 1;

      if (phase === 'flash') {
        const e = now - phaseStartRef.current;
        if (e >= FLASH_MS) {
          phaseRef.current = 'fade';
          phaseStartRef.current = now;
        } else {
          const k = e / FLASH_MS;
          glow = 1 + k * 0.9; // brightness swell
          alpha = 1;
        }
      }
      if (phaseRef.current === 'fade') {
        const e = now - phaseStartRef.current;
        if (e >= FADE_MS) {
          clearAll();
          return; // idle — loop stops
        }
        const k = e / FADE_MS;
        alpha = 1 - k * k; // ease-out fade
        glow = 1.2 * (1 - k);
      }

      const strokes = strokesRef.current;
      for (let i = 0; i < strokes.length; i++) {
        const isHead = drawingRef.current && strokes[i] === currentRef.current;
        drawStroke(strokes[i], alpha, glow, isHead);
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;

      // Keep looping while there's motion to render.
      const keepGoing =
        phaseRef.current === 'live' || phaseRef.current === 'flash' || phaseRef.current === 'fade';
      if (keepGoing) rafRef.current = requestAnimationFrame(frame);
    };
    const ensureLoop = () => {
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(frame);
    };

    // ── Pointer drawing ──
    const beginSession = () => {
      // A pointerdown only reaches us while Rust has armed the mouse capture, so
      // it is proof of a live hold — self-arm if the stt-event ordering lagged.
      activeRef.current = true;
      handedOffRef.current = false;
      phaseRef.current = 'live';
    };

    const onDown = (e: PointerEvent) => {
      if (handedOffRef.current) return; // already sending — ignore stray input
      beginSession();
      drawingRef.current = true;
      const stroke: Stroke = { pts: [], done: false };
      strokeStartRef.current = performance.now();
      stroke.pts.push({ x: e.clientX, y: e.clientY, t: 0 });
      currentRef.current = stroke;
      strokesRef.current.push(stroke);
      if (!firstStrokeEmittedRef.current) {
        firstStrokeEmittedRef.current = true;
        emitRef.current?.('o8:spatial-ink-first-stroke', { sessionId: sessionIdRef.current });
      }
      try {
        (e.target as Element)?.setPointerCapture?.(e.pointerId);
      } catch {
        /* noop */
      }
      ensureLoop();
    };

    const pushPoint = (x: number, y: number) => {
      const stroke = currentRef.current;
      if (!stroke) return;
      stroke.pts.push({ x, y, t: performance.now() - strokeStartRef.current });
    };

    const onMove = (e: PointerEvent) => {
      if (!drawingRef.current || !currentRef.current) return;
      // Coalesced events → smooth strokes even under fast motion / vsync gaps.
      const evs =
        typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
      if (evs && evs.length) {
        for (const ce of evs) pushPoint(ce.clientX, ce.clientY);
      } else {
        pushPoint(e.clientX, e.clientY);
      }
      ensureLoop();
    };

    const onUp = () => {
      if (!drawingRef.current) return;
      drawingRef.current = false;
      if (currentRef.current) currentRef.current.done = true;
      currentRef.current = null;
      // Strokes HOLD (still 'live') until the final event hands off — a big
      // circle survives the rest of the utterance.
      ensureLoop();
    };

    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);

    // ── Handoff (final) + teardown ──
    const emitStrokes = () => {
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      const strokes = strokesRef.current
        .filter((s) => s.pts.length > 0)
        .map((s) => ({
          points: s.pts.map((p) => ({ x: p.x / vw, y: p.y / vh, t: p.t })),
        }));
      emitRef.current?.('o8:spatial-ink-strokes', {
        sessionId: sessionIdRef.current,
        strokes,
        viewport: { w: vw, h: vh, scale: dprRef.current },
      });
    };

    const handoff = () => {
      if (handedOffRef.current) return;
      handedOffRef.current = true;
      drawingRef.current = false;
      const hasInk = strokesRef.current.some((s) => s.pts.length > 0);
      emitStrokes();
      if (!hasInk) {
        // Nothing drawn — nothing to flash. Reset for the next hold.
        resetSession();
        return;
      }
      // Snapshot flash → fade → clear.
      if (reducedRef.current) {
        clearAll();
        resetSession();
        return;
      }
      phaseRef.current = 'flash';
      phaseStartRef.current = performance.now();
      ensureLoop();
    };

    const resetSession = () => {
      activeRef.current = false;
      firstStrokeEmittedRef.current = false;
      sessionIdRef.current = null;
    };

    const hardClear = () => {
      clearAll();
      resetSession();
      handedOffRef.current = false;
    };

    const handleStt = (p: SttPayload) => {
      const type = p.type;
      if (typeof p.sessionId === 'number') sessionIdRef.current = p.sessionId;

      if (type === 'system-start') {
        if (p.lane === 'agent') {
          // Fresh hold.
          hardClear();
          activeRef.current = true;
          phaseRef.current = 'live';
        }
        return;
      }

      if (type === 'final') {
        // Hand the strokes to Rust before polish completes.
        handoff();
        return;
      }

      if (TERMINAL.has(type ?? '')) {
        // Belt for the mouse-capture safety chain — always ask Rust to disarm.
        emitRef.current?.('o8:spatial-ink-disarm-request', { sessionId: sessionIdRef.current });
        // Let an in-flight flash/fade finish; otherwise clear now.
        if (phaseRef.current !== 'flash' && phaseRef.current !== 'fade') {
          hardClear();
        }
      }
    };

    // ── Tauri event wiring ──
    let disposed = false;
    let unStt: (() => void) | null = null;
    let unClear: (() => void) | null = null;
    if (isTauri()) {
      import('@tauri-apps/api/event')
        .then(({ listen, emit }) => {
          emitRef.current = (event, payload) => {
            void emit(event, payload);
          };
          const p1 = listen<SttPayload>('o8:stt-event', (e) => handleStt(e.payload ?? {}));
          const p2 = listen('o8:spatial-ink-clear', () => {
            // Rust disarm — clear unless a flash/fade is mid-play.
            if (phaseRef.current !== 'flash' && phaseRef.current !== 'fade') hardClear();
          });
          return Promise.all([p1, p2]);
        })
        .then((uns) => {
          if (disposed) {
            uns?.forEach((u) => u());
            return;
          }
          unStt = uns?.[0] ?? null;
          unClear = uns?.[1] ?? null;
        })
        .catch(() => {
          /* noop — no bridge means the overlay simply never draws */
        });
    }

    return () => {
      disposed = true;
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      try {
        unStt?.();
        unClear?.();
      } catch {
        /* noop */
      }
    };
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        margin: 0,
        padding: 0,
        background: 'transparent',
        // The canvas itself takes the pointer; nothing else on this surface.
        touchAction: 'none',
        cursor: 'crosshair',
        overflow: 'hidden',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'fixed',
          inset: 0,
          display: 'block',
          background: 'transparent',
        }}
      />
    </div>
  );
}
