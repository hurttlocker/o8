'use client';

/**
 * SceneCard — a card / modal / pricing surface with an animated sunrise
 * landscape background (drifting valley fog + glowing sun disc + layered hazy
 * ridges + lit grass). Reuses the procedural scene shader from SunriseFooter,
 * framed as a rounded card with an inset hairline + soft shadow, content
 * composited on top over a legibility scrim.
 *
 * Dependency-free raw WebGL. Authored from scratch.
 */

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { SUNRISE_VERT, SUNRISE_FRAG, SUNRISE_PAL } from '../footer-sunrise/SunriseFooter';

export interface SceneCardProps {
  width?: number;
  height?: number;
  borderRadius?: number;
  horizon?: number;
  sunX?: number;
  sunY?: number;
  fog?: number;
  density?: number;
  speed?: number;
  scale?: number;
  grassHeight?: number;
  /** Bottom scrim strength (0–0.8) for content legibility. */
  scrim?: number;
  autoPlay?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

const DEFAULTS = {
  width: 380,
  height: 460,
  borderRadius: 18,
  horizon: 0.52,
  sunX: 0.72,
  sunY: 0.58,
  fog: 1,
  density: 0.5,
  speed: 1,
  scale: 1.15,
  grassHeight: 0.14,
  scrim: 0.42,
  autoPlay: true,
};

function hexRaw(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (Number.isNaN(n) || h.length !== 6) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('[scene-card] compile failed:', gl.getShaderInfoLog(sh));
    return null;
  }
  return sh;
}

export function SceneCard(props: SceneCardProps) {
  const p = { ...DEFAULTS, ...props };
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef(p);
  propsRef.current = p;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false });
    if (!gl) { console.error('[scene-card] WebGL unavailable'); return; }

    const vs = compile(gl, gl.VERTEX_SHADER, SUNRISE_VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, SUNRISE_FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.error('[scene-card] link failed', gl.getProgramInfoLog(prog)); return; }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = (n: string) => gl.getUniformLocation(prog, n);
    const U = {
      time: u('u_time'), res: u('u_res'), skyTop: u('u_skyTop'), skyHorizon: u('u_skyHorizon'),
      sun: u('u_sun'), fog: u('u_fog'), rFar: u('u_rFar'), rMid: u('u_rMid'), rNear: u('u_rNear'), grass: u('u_grass'),
      sunPos: u('u_sunPos'), horizon: u('u_horizon'), fogAmt: u('u_fogAmt'), density: u('u_density'), speed: u('u_speed'), scale: u('u_scale'), grassH: u('u_grassH'),
    };
    const set3 = (l: WebGLUniformLocation | null, hex: string) => { const c = hexRaw(hex); gl.uniform3f(l, c[0], c[1], c[2]); };

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let raf = 0, clock = 0, last = performance.now();

    const resize = () => {
      const cur = propsRef.current;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(cur.width * dpr)), h = Math.max(1, Math.round(cur.height * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
    };

    const draw = (now: number) => {
      const cur = propsRef.current;
      const dt = Math.min((now - last) / 1000, 0.05); last = now;
      if (!reduce) clock += dt * cur.speed;
      resize();
      const P = SUNRISE_PAL;
      gl.uniform1f(U.time, clock);
      gl.uniform2f(U.res, canvas.width, canvas.height);
      set3(U.skyTop, P.skyTop); set3(U.skyHorizon, P.skyHorizon); set3(U.sun, P.sun);
      set3(U.fog, P.fog); set3(U.rFar, P.rFar); set3(U.rMid, P.rMid); set3(U.rNear, P.rNear); set3(U.grass, P.grass);
      gl.uniform2f(U.sunPos, cur.sunX, cur.sunY);
      gl.uniform1f(U.horizon, cur.horizon);
      gl.uniform1f(U.fogAmt, cur.fog);
      gl.uniform1f(U.density, cur.density);
      gl.uniform1f(U.speed, cur.speed);
      gl.uniform1f(U.scale, cur.scale);
      gl.uniform1f(U.grassH, cur.grassHeight);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (cur.autoPlay && !reduce) raf = requestAnimationFrame(draw); else raf = 0;
    };
    raf = requestAnimationFrame(draw);
    return () => { if (raf) cancelAnimationFrame(raf); gl.deleteProgram(prog); gl.deleteBuffer(buf); };

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
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.14), 0 24px 60px -22px rgba(40,28,12,0.55)',
        ...props.style,
      }}
    >
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />
      {/* legibility scrim — warm dark from the bottom */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background: `linear-gradient(180deg, rgba(40,28,12,0) 40%, rgba(30,20,8,${p.scrim}) 100%)`,
        }}
      />
      {props.children != null && <div style={{ position: 'absolute', inset: 0, zIndex: 1 }}>{props.children}</div>}
    </div>
  );
}

export default SceneCard;
