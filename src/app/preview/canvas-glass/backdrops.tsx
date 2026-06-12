'use client';

/**
 * Canvas depth layers (#1232) — the operator-picked set, every mood
 * custom-authored for the o8 glass (no library presets): Trails and
 * Dots are hand-rolled 2D-canvas pieces (Anthropic-style dot walkers,
 * flag-in-the-wind dot field); Paper / Aurora / Warp / Radial run Paper
 * Shaders with near-black slate + warm paper palettes. Selectable from
 * the Canvas tuner.
 *
 * Perf: WebGL paints opaque, so wrapper opacity keeps the desktop
 * reading through. minPixelRatio 1 + maxPixelCount cap are the
 * full-window levers; the library pauses when the document hides.
 */

import { useEffect, useRef, useState } from 'react';
import {
  GrainGradient,
  MeshGradient,
  StaticRadialGradient,
  Warp,
} from '@paper-design/shaders-react';

const FILL = { position: 'absolute' as const, inset: 0, width: '100%', height: '100%' };
// Tame: slow, full-bleed, no Retina oversampling, pixel-capped.
const TAME = { speed: 0.12, fit: 'cover' as const, minPixelRatio: 1, maxPixelCount: 1280 * 720, style: FILL };

/**
 * The Anthropic dot-trail layer — tiny dots lighting along the same 26px
 * lattice as the canvas dot grid, walking orthogonally with occasional
 * 90° turns, tails fading behind them. Slower than the reference, and
 * each walker breathes in and out of existence so it never demands the
 * eye. Plain 2D canvas — no WebGL needed for this one.
 */
function SnakeTrails() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const PITCH = 26;          // matches the CSS dot grid
    const RADIUS = 1.5;
    const PEAK = 0.5;          // peak white alpha
    const STEP_MS = 300;       // head advance — calmer than the reference's ~150ms
    const DECAY_MS = 2200;     // a lit dot takes ~2.2s to fade fully
    const SNAKES = 7;
    const FADE_IN_MS = 1600;   // walker emission breathes in…
    const FADE_OUT_MS = 2200;  // …and out at end of life

    interface Snake {
      x: number;
      y: number;
      dir: number;           // 0 right, 1 down, 2 left, 3 up
      straight: number;      // steps left before a turn is allowed
      bornAt: number;
      dieAt: number;
      nextStepAt: number;
      respawnAt: number;     // when dead, the time to come back
    }

    let cols = 0;
    let rows = 0;
    const lit = new Map<number, { at: number; strength: number }>();
    const snakes: Snake[] = [];
    let raf = 0;
    let disposed = false;

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.floor(rect.width / PITCH);
      rows = Math.floor(rect.height / PITCH);
    };

    const spawn = (snake: Snake, now: number, delay = 0) => {
      snake.x = 1 + Math.floor(Math.random() * Math.max(1, cols - 2));
      snake.y = 1 + Math.floor(Math.random() * Math.max(1, rows - 2));
      snake.dir = Math.floor(Math.random() * 4);
      snake.straight = 3 + Math.floor(Math.random() * 4);
      snake.bornAt = now + delay;
      snake.dieAt = snake.bornAt + 9000 + Math.random() * 7000;
      snake.nextStepAt = snake.bornAt + Math.random() * STEP_MS;
      snake.respawnAt = 0;
    };

    const emission = (snake: Snake, now: number) => {
      if (now < snake.bornAt) return 0;
      const inT = Math.min(1, (now - snake.bornAt) / FADE_IN_MS);
      const outT = Math.min(1, Math.max(0, (snake.dieAt - now) / FADE_OUT_MS));
      return Math.min(inT, outT);
    };

    const step = (snake: Snake, now: number) => {
      // Turn — never a reversal, mostly straight runs of 3–6 cells.
      if (snake.straight <= 0) {
        snake.dir = (snake.dir + (Math.random() < 0.5 ? 1 : 3)) % 4;
        snake.straight = 3 + Math.floor(Math.random() * 4);
      }
      snake.straight -= 1;
      snake.x += snake.dir === 0 ? 1 : snake.dir === 2 ? -1 : 0;
      snake.y += snake.dir === 1 ? 1 : snake.dir === 3 ? -1 : 0;
      // Off the lattice (or past its lifetime) → rest, then come back.
      if (snake.x < 0 || snake.y < 0 || snake.x >= cols || snake.y >= rows || now >= snake.dieAt) {
        snake.respawnAt = now + 600 + Math.random() * 1800;
        return;
      }
      const strength = emission(snake, now);
      if (strength > 0.02) lit.set(snake.y * 4096 + snake.x, { at: now, strength });
    };

    const frame = () => {
      if (disposed) return;
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const now = performance.now();

      for (const snake of snakes) {
        if (snake.respawnAt > 0) {
          if (now >= snake.respawnAt) spawn(snake, now);
          continue;
        }
        while (now >= snake.nextStepAt && snake.respawnAt === 0) {
          step(snake, now);
          snake.nextStepAt += STEP_MS * (0.9 + Math.random() * 0.25);
        }
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ffffff';
      for (const [key, entry] of lit) {
        const t = (now - entry.at) / DECAY_MS;
        if (t >= 1) {
          lit.delete(key);
          continue;
        }
        const alpha = PEAK * entry.strength * Math.pow(1 - t, 1.5);
        if (alpha < 0.01) continue;
        ctx.globalAlpha = alpha;
        const gx = (key % 4096) * PITCH + PITCH / 2;
        const gy = Math.floor(key / 4096) * PITCH + PITCH / 2;
        ctx.beginPath();
        ctx.arc(gx, gy, RADIUS, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    resize();
    const now = performance.now();
    for (let i = 0; i < SNAKES; i++) {
      const snake: Snake = { x: 0, y: 0, dir: 0, straight: 0, bornAt: 0, dieAt: 0, nextStepAt: 0, respawnAt: 0 };
      // Stagger births so the field never pulses in unison.
      spawn(snake, now, i * 900);
      snakes.push(snake);
    }
    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} style={FILL} />;
}

/**
 * Flag-in-the-wind dots — a sparse field of small dots displaced by two
 * slow traveling sine waves, so neighbours move together and the whole
 * field billows like cloth. Amplitude and alpha modulation are tuned to
 * "just barely make out that they're moving together". 30fps on plain
 * 2D canvas (~1,200 dots).
 */
function WindDots() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const PITCH = 36;          // sparse — wider than the chrome dot grid
    const RADIUS = 1;          // small
    const BASE_ALPHA = 0.16;
    const WAVE_ALPHA = 0.07;   // light catching the cloth
    const AMP_X = 3;           // px of displacement — subtle
    const AMP_Y = 2.4;

    let width = 0;
    let height = 0;
    let raf = 0;
    let disposed = false;
    let skip = false;

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      width = rect.width;
      height = rect.height;
    };

    const frame = () => {
      if (disposed) return;
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      skip = !skip;             // 30fps is plenty for this drift
      if (skip) return;

      const t = performance.now() / 1000;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ffffff';
      for (let gy = PITCH / 2; gy < height + PITCH; gy += PITCH) {
        for (let gx = PITCH / 2; gx < width + PITCH; gx += PITCH) {
          // Two traveling waves, ~350px wavelength, crest crossing ~9s.
          const w1 = Math.sin(gx * 0.018 + gy * 0.006 + t * 0.7);
          const w2 = Math.sin(gx * 0.011 - gy * 0.013 + t * 0.45 + 1.7);
          const dx = (w1 * 0.6 + w2 * 0.4) * AMP_X;
          const dy = (Math.cos(gx * 0.014 + gy * 0.01 + t * 0.55) * 0.7 + w2 * 0.3) * AMP_Y;
          ctx.globalAlpha = BASE_ALPHA + WAVE_ALPHA * (0.5 + 0.5 * w1);
          ctx.beginPath();
          ctx.arc(gx + dx, gy + dy, RADIUS, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    };

    resize();
    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} style={FILL} />;
}

/**
 * The o8 orbit pulse — the brand's dual-orbit mark, way small, drawn in
 * faded dither (airy stipple, not cloud), breathing a slow zoom. A fixed
 * "sun" sits upper-right of the mark; as stipple drifts along the orbit
 * paths and passes that spot it glows amber, like the canvas is sunlit.
 */
function OrbitPulse() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const DOTS_PER_RING = 150;
    const DENSITY = 0.6;        // share of stipple actually drawn — airy
    const FLOW = 0.07;          // rad/s drift along the orbit
    const BREATH_S = 13;        // one zoom in+out
    const SUN_ANGLE = -0.9;     // screen-space, upper right
    const SUN_WIDTH = 0.62;     // gaussian sigma (rad) — a graceful arc, not a hotspot
    const TILT = 0.42;          // ellipse minor/major ratio
    const LEAN = 0.49;          // ring inclination (rad) — crossed = the 8

    let width = 0;
    let height = 0;
    let raf = 0;
    let disposed = false;
    let skip = false;

    const hash = (n: number) => {
      const s = Math.sin(n * 12.9898) * 43758.5453;
      return s - Math.floor(s);
    };

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      width = rect.width;
      height = rect.height;
    };

    const frame = () => {
      if (disposed) return;
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      skip = !skip;
      if (skip) return;

      const t = performance.now() / 1000;
      const cx = width / 2;
      const cy = height * 0.44;
      const radius = Math.min(width, height) * 0.13;
      const breath = 1 + 0.08 * Math.sin((t * Math.PI * 2) / BREATH_S);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (let ring = 0; ring < 2; ring++) {
        const lean = ring === 0 ? LEAN : -LEAN;
        const cosL = Math.cos(lean);
        const sinL = Math.sin(lean);
        for (let i = 0; i < DOTS_PER_RING; i++) {
          const seed = ring * 1000 + i;
          if (hash(seed + 0.31) > DENSITY) continue;
          const u = (i / DOTS_PER_RING) * Math.PI * 2 + t * FLOW * (ring === 0 ? 1 : -1);
          // Ellipse point, leaned, breathed.
          const ex = Math.cos(u) * radius;
          const ey = Math.sin(u) * radius * TILT;
          const x = (ex * cosL - ey * sinL) * breath;
          const y = (ex * sinL + ey * cosL) * breath;
          // Sunlit pass — screen angle vs the fixed sun spot.
          let delta = Math.atan2(y, x) - SUN_ANGLE;
          delta = Math.atan2(Math.sin(delta), Math.cos(delta));
          const glow = Math.exp(-((delta / SUN_WIDTH) ** 2));
          // Faded dither: jittered position, hashed alpha, gentle flicker.
          const jx = (hash(seed + 1.7) - 0.5) * 2.6;
          const jy = (hash(seed + 2.9) - 0.5) * 2.6;
          const flicker = 0.04 * Math.sin(t * 1.3 + i * 0.7);
          const alpha = 0.11 + 0.08 * hash(seed + 4.2) + glow * 0.32 + flicker;
          if (alpha < 0.02) continue;
          const r = 0.6 + 0.4 * hash(seed + 5.5) + glow * 0.5;
          const cr = Math.round(160 + (245 - 160) * glow);
          const cg = Math.round(176 + (158 - 176) * glow);
          const cb = Math.round(196 + (11 - 196) * glow);
          ctx.fillStyle = `rgba(${cr},${cg},${cb},${Math.min(0.85, alpha).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(cx + x + jx, cy + y + jy, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // The nucleus — one quiet dot breathing with the rings.
      ctx.fillStyle = `rgba(190,202,218,${(0.18 + 0.08 * Math.sin((t * Math.PI * 2) / BREATH_S)).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(cx, cy, 1.8 * breath, 0, Math.PI * 2);
      ctx.fill();
    };

    resize();
    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} style={FILL} />;
}

export function CanvasBackdropLayer({ kind }: { kind: string }) {
  // WebGL2 probe — the shader library throws without it. Trails is 2D
  // canvas and exempt.
  const [webgl, setWebgl] = useState(false);
  useEffect(() => {
    try {
      setWebgl(Boolean(document.createElement('canvas').getContext('webgl2')));
    } catch {
      setWebgl(false);
    }
  }, []);

  if (kind === 'none') return null;

  const wrap = (opacity: number, child: React.ReactNode) => (
    <div aria-hidden style={{ ...FILL, pointerEvents: 'none', zIndex: 1, overflow: 'hidden' }}>
      <div style={{ ...FILL, opacity }}>{child}</div>
    </div>
  );

  if (kind === 'trails') return wrap(1, <SnakeTrails />);
  if (kind === 'dots') return wrap(1, <WindDots />);
  if (kind === 'pulse') return wrap(1, <OrbitPulse />);
  if (!webgl) return null;

  switch (kind) {
    case 'paper':
      return wrap(0.5, (
        <GrainGradient
          colors={['#171310', '#100d0a', '#1c1712']}
          colorBack="#0a0806"
          shape="wave"
          softness={0.9}
          intensity={0.18}
          noise={0.32}
          {...TAME}
          speed={0.05}
          scale={1.3}
        />
      ));
    case 'aurora':
      return wrap(0.5, (
        <MeshGradient
          colors={['#070b12', '#0a1626', '#121034', '#07181d']}
          distortion={0.5}
          swirl={0.3}
          grainOverlay={0.08}
          {...TAME}
          speed={0.1}
          scale={1.15}
        />
      ));
    case 'warp':
      // Ink marbling — charcoal fields folding over a split edge, slow.
      return wrap(0.5, (
        <Warp
          colors={['#07090d', '#10151c', '#1a2230']}
          shape="edge"
          softness={0.9}
          distortion={0.2}
          swirl={0.7}
          swirlIterations={8}
          proportion={0.5}
          {...TAME}
          speed={0.06}
          scale={1.2}
        />
      ));
    case 'radial':
      // Desk lamp — one still pool of steel light from above center.
      return wrap(0.5, (
        <StaticRadialGradient
          colorBack="#06080b"
          colors={['#1a2433', '#0e141d']}
          radius={0.9}
          focalDistance={0.3}
          focalAngle={90}
          falloff={0.6}
          mixing={0.7}
          distortion={0.15}
          grainMixer={0.1}
          grainOverlay={0.08}
          {...TAME}
          speed={0}
          offsetY={-0.3}
        />
      ));
    default:
      return null;
  }
}
