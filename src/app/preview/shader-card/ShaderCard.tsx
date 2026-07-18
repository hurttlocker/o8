'use client';

/**
 * ShaderCard — a card with an animated WebGL fragment-shader background.
 *
 * Recreates the *behavior* of the ReactBits "Shader Card" (organic flowing
 * plasma + branching filaments over a single base color) with our own GLSL, so
 * it's dependency-free and matches the repo's raw-WebGL convention
 * (see canvas-glass/refraction-ball.tsx). No code is copied from the source lib.
 *
 * Technique: domain-warped fBm. A base value-noise fBm is warped by a second
 * fBm pass (the "branching"), a third pass adds the slow wave undulation, and a
 * ridged transform (1 - |2n-1|) turns the smooth field into glowing filaments.
 * A radial falloff anchored at `positionY` gives the core-and-spread look.
 *
 * Tuning lives entirely in props so the test page can drive sliders against it.
 */

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

export interface ShaderCardProps {
  /** Base hue of the plasma, hex. */
  color?: string;
  /** Card width / height in CSS px. */
  width?: number;
  height?: number;
  borderRadius?: number;
  /** Animation speed multiplier (0.1–3.0). 0 ~ frozen. */
  speed?: number;
  /** Vertical anchor of the glow core. 0 = top, 1 = bottom. */
  positionY?: number;
  /** Overall pattern zoom. Larger = zoomed in (fewer, bigger features). */
  scale?: number;
  /** fBm frequency — texture density of the field. */
  noiseScale?: number;
  /** Domain-warp strength — drives the branching/fractal extensions. */
  branchIntensity?: number;
  /** Slow undulation strength applied to the field. */
  waveAmount?: number;
  /** Radial falloff inner/outer thresholds (0–1, edgeMin < edgeMax). */
  edgeMin?: number;
  edgeMax?: number;
  /** Falloff curve power (>1 tightens the core). */
  falloff?: number;
  /** Brightness of the hot core highlight. */
  boost?: number;
  /** Overall plasma opacity over the dark base (0–1). */
  opacity?: number;
  /** Dark base the plasma is composited over. */
  background?: string;
  /** Run the rAF loop. When false, renders a single static frame. */
  autoPlay?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

const DEFAULTS: Required<Omit<ShaderCardProps, 'className' | 'style' | 'children'>> = {
  color: '#FF9FFC',
  width: 400,
  height: 500,
  borderRadius: 12,
  speed: 1,
  positionY: 0.52,
  scale: 1,
  noiseScale: 2.6,
  branchIntensity: 0.85,
  waveAmount: 0.35,
  edgeMin: 0.15,
  edgeMax: 0.95,
  falloff: 1.6,
  boost: 1.0,
  opacity: 1,
  background: '#0a0a0d',
  autoPlay: true,
};

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 v_uv;

uniform float u_time;
uniform vec2  u_res;
uniform vec3  u_color;
uniform vec3  u_bg;
uniform float u_positionY;
uniform float u_scale;
uniform float u_noiseScale;
uniform float u_branch;
uniform float u_wave;
uniform float u_edgeMin;
uniform float u_edgeMax;
uniform float u_falloff;
uniform float u_boost;
uniform float u_opacity;

// --- value noise + fBm -----------------------------------------------------
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i + vec2(0.0, 0.0));
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    v += amp * noise(p);
    p = rot * p * 2.0 + 17.1;
    amp *= 0.5;
  }
  return v;
}

void main() {
  // aspect-corrected centered coords, -1..1-ish
  vec2 uv = v_uv;
  float aspect = u_res.x / max(u_res.y, 1.0);
  vec2 p = (uv - vec2(0.5, 1.0 - u_positionY));
  p.x *= aspect;
  p /= max(u_scale, 0.0001);

  float t = u_time;
  // slow upward drift so the whole field flows like liquid light
  vec2 drift = vec2(0.0, -t * 0.22);
  vec2 sp = p * u_noiseScale + drift;

  // domain warp — branching
  vec2 q = vec2(
    fbm(sp + vec2(0.0, 0.0) + t * 0.10),
    fbm(sp + vec2(5.2, 1.3) - t * 0.08)
  );
  vec2 r = vec2(
    fbm(sp + q * u_branch + vec2(1.7, 9.2) + t * 0.12),
    fbm(sp + q * u_branch + vec2(8.3, 2.8) - t * 0.10)
  );
  float field = fbm(sp + r * (u_branch + u_wave) + t * 0.06);

  // coarse ridged transform -> broad glowing veins
  float coarse = 1.0 - abs(2.0 * field - 1.0);
  coarse = pow(clamp(coarse, 0.0, 1.0), 1.6);

  // finer second-scale ridged detail riding the same warp -> filament branches
  float fine = fbm(sp * 2.3 + r * (u_branch * 1.6) + drift * 1.5 + vec2(3.1, 7.7));
  fine = 1.0 - abs(2.0 * fine - 1.0);
  fine = pow(clamp(fine, 0.0, 1.0), 2.6);

  float ridge = mix(coarse, coarse * (0.55 + 0.9 * fine), 0.7);

  // radial falloff anchored at positionY — slightly vertical so it spreads
  // up/down like a flame instead of a tight ball
  vec2 e = p * vec2(1.0, 0.72);
  float d = length(e);
  float glow = smoothstep(u_edgeMax, u_edgeMin, d);
  glow = pow(glow, u_falloff);

  float intensity = ridge * glow;
  // hot core — tight, so the hue stays dominant instead of washing to white
  float core = pow(glow, u_falloff * 3.4) * u_boost;
  intensity = clamp(intensity + core * 0.32, 0.0, 1.25);

  vec3 col = u_color * intensity;
  // lift toward white only at the very hottest filament tips
  col += vec3(1.0) * pow(intensity, 6.0) * 0.16 * u_boost;

  vec3 outc = mix(u_bg, col, clamp(intensity * u_opacity, 0.0, 1.0));
  // keep a faint base tint of color in the body
  outc = mix(outc, outc + u_color * 0.04 * u_opacity, glow);

  gl_FragColor = vec4(outc, 1.0);
}`;

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (Number.isNaN(n) || h.length !== 6) return [1, 0.62, 0.99];
  // sRGB -> approx linear so additive math reads right
  const srgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  return srgb.map((c) => Math.pow(c, 2.2)) as [number, number, number];
}

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('[shader-card] shader compile failed:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function ShaderCard(props: ShaderCardProps) {
  const p = { ...DEFAULTS, ...props };
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // live ref so the rAF loop reads fresh props without re-initializing WebGL
  const propsRef = useRef(p);
  propsRef.current = p;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false, premultipliedAlpha: false });
    if (!gl) {
      console.error('[shader-card] WebGL unavailable');
      return;
    }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('[shader-card] link failed:', gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const U = {
      time: gl.getUniformLocation(prog, 'u_time'),
      res: gl.getUniformLocation(prog, 'u_res'),
      color: gl.getUniformLocation(prog, 'u_color'),
      bg: gl.getUniformLocation(prog, 'u_bg'),
      positionY: gl.getUniformLocation(prog, 'u_positionY'),
      scale: gl.getUniformLocation(prog, 'u_scale'),
      noiseScale: gl.getUniformLocation(prog, 'u_noiseScale'),
      branch: gl.getUniformLocation(prog, 'u_branch'),
      wave: gl.getUniformLocation(prog, 'u_wave'),
      edgeMin: gl.getUniformLocation(prog, 'u_edgeMin'),
      edgeMax: gl.getUniformLocation(prog, 'u_edgeMax'),
      falloff: gl.getUniformLocation(prog, 'u_falloff'),
      boost: gl.getUniformLocation(prog, 'u_boost'),
      opacity: gl.getUniformLocation(prog, 'u_opacity'),
    };

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    let raf = 0;
    let clock = 0;
    let last = performance.now();

    const resize = () => {
      const cur = propsRef.current;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(cur.width * dpr));
      const h = Math.max(1, Math.round(cur.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
    };

    const draw = (now: number) => {
      const cur = propsRef.current;
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      if (!reduce) clock += dt * cur.speed;

      resize();
      const [cr, cg, cb] = hexToRgb(cur.color);
      const [br, bg2, bb] = hexToRgb(cur.background);

      gl.uniform1f(U.time, clock);
      gl.uniform2f(U.res, canvas.width, canvas.height);
      gl.uniform3f(U.color, cr, cg, cb);
      gl.uniform3f(U.bg, br, bg2, bb);
      gl.uniform1f(U.positionY, cur.positionY);
      gl.uniform1f(U.scale, cur.scale);
      gl.uniform1f(U.noiseScale, cur.noiseScale);
      gl.uniform1f(U.branch, cur.branchIntensity);
      gl.uniform1f(U.wave, cur.waveAmount);
      gl.uniform1f(U.edgeMin, cur.edgeMin);
      gl.uniform1f(U.edgeMax, cur.edgeMax);
      gl.uniform1f(U.falloff, cur.falloff);
      gl.uniform1f(U.boost, cur.boost);
      gl.uniform1f(U.opacity, cur.opacity);

      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (propsRef.current.autoPlay && !reduce) {
        raf = requestAnimationFrame(draw);
      } else {
        raf = 0;
      }
    };

    raf = requestAnimationFrame(draw);

    // if autoPlay flips on later, the test page remounts via key; for static
    // frames we still drew one above.
    return () => {
      if (raf) cancelAnimationFrame(raf);
      gl.deleteProgram(prog);
      gl.deleteBuffer(buf);
    };

  }, []);

  return (
    <div
      className={props.className}
      style={{
        position: 'relative',
        width: p.width,
        height: p.height,
        borderRadius: p.borderRadius,
        overflow: 'hidden',
        boxShadow:
          'inset 0 0 0 1px rgba(255,255,255,0.08), 0 18px 50px -18px rgba(0,0,0,0.55)',
        ...props.style,
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          display: 'block',
        }}
      />
      {props.children != null && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 1 }}>{props.children}</div>
      )}
    </div>
  );
}

export default ShaderCard;
