'use client';

/**
 * FooterImage — bring a still photo footer to life the reference way:
 * static landscape photo + a slow DRIFTING HAZE overlay (WebGL, alpha) settling
 * in a horizontal band + infrequent solitary BIRDS (2D) + a legibility scrim.
 *
 * This is the no-video path: it animates any still without needing Veo. When a
 * Veo clip is ready, swap the <img> base for a looping <video> and keep (or
 * drop) the haze/bird layers. Authored from scratch, dependency-free raw WebGL.
 */

import { useEffect, useRef, type CSSProperties } from 'react';

export interface FooterImageProps {
  src: string;
  height?: number;
  /** Haze tint (hex), its peak opacity, drift speed, and where it sits/spreads. */
  hazeColor?: string;
  hazeOpacity?: number;
  hazeSpeed?: number;
  hazeBandY?: number; // 0 bottom .. 1 top — center of the haze band
  hazeBandH?: number; // band half-height
  hazeScale?: number;
  /** Bird silhouette color, avg seconds between spawns, max on screen. */
  birdColor?: string;
  birdRate?: number;
  maxBirds?: number;
  /** Object position for the photo (e.g. 'center 60%'). */
  objectPosition?: string;
  autoPlay?: boolean;
  className?: string;
  style?: CSSProperties;
}

const DEFAULTS = {
  height: 340,
  hazeColor: '#dfe8f0',
  hazeOpacity: 0.5,
  hazeSpeed: 1,
  hazeBandY: 0.44,
  hazeBandH: 0.2,
  hazeScale: 1,
  birdColor: '#2b3138',
  birdRate: 5,
  maxBirds: 2,
  objectPosition: 'center 55%',
  autoPlay: true,
};

const VERT = `
attribute vec2 a_pos; varying vec2 v_uv;
void main(){ v_uv=a_pos*0.5+0.5; gl_Position=vec4(a_pos,0.0,1.0); }`;

const FRAG = `
precision highp float;
varying vec2 v_uv;
uniform float u_time;
uniform vec2  u_res;
uniform vec3  u_color;
uniform float u_opacity;
uniform float u_speed;
uniform float u_bandY;
uniform float u_bandH;
uniform float u_scale;

float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p),f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y); }
float fbm(vec2 p){ float v=0.0,a=0.5; mat2 r=mat2(0.8,-0.6,0.6,0.8);
  for(int i=0;i<5;i++){ v+=a*noise(p); p=r*p*2.0+11.3; a*=0.5; } return v; }

float haze(vec2 uv, float yC, float yW, float scale, float speed, float t){
  vec2 p = vec2(uv.x*scale - t*speed, uv.y*scale*1.5);
  p.y += 0.18*fbm(p*0.6 + t*0.04);
  float n = fbm(p);
  float band = exp(-pow((uv.y - yC)/yW, 2.0));
  float cover = smoothstep(0.46, 0.84, n);
  return clamp(cover*band, 0.0, 1.0);
}

void main(){
  vec2 uv = v_uv;
  float t = u_time;
  float s = max(u_scale, 0.2);
  // two parallax haze sheets for depth
  float h1 = haze(uv, u_bandY,        u_bandH,       3.0/s, 0.022, t);
  float h2 = haze(uv, u_bandY-0.06,   u_bandH*0.8,   5.0/s, 0.040, t);
  float a = (max(h1, h2*0.85)) * u_opacity;
  gl_FragColor = vec4(u_color, clamp(a, 0.0, 1.0));
}`;

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
    console.error('[footer-image] compile failed:', gl.getShaderInfoLog(sh));
    return null;
  }
  return sh;
}

interface Bird { x: number; y: number; vx: number; size: number; phase: number; flapSpeed: number; arc: number; born: number; alpha: number; }

export function FooterImage(props: FooterImageProps) {
  const p = { ...DEFAULTS, ...props };
  const hazeRef = useRef<HTMLCanvasElement | null>(null);
  const birdRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(p);
  propsRef.current = p;

  useEffect(() => {
    const hazeC = hazeRef.current, birdC = birdRef.current, wrap = wrapRef.current;
    if (!hazeC || !birdC || !wrap) return;
    const gl = hazeC.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false });
    const ctx = birdC.getContext('2d');
    if (!gl || !ctx) { console.error('[footer-image] context unavailable'); return; }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.error('[footer-image] link failed'); return; }
    gl.useProgram(prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = (n: string) => gl.getUniformLocation(prog, n);
    const U = { time: u('u_time'), res: u('u_res'), color: u('u_color'), opacity: u('u_opacity'), speed: u('u_speed'), bandY: u('u_bandY'), bandH: u('u_bandH'), scale: u('u_scale') };

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let visible = true;
    const io = new IntersectionObserver((e) => { visible = e[0]?.isIntersecting ?? true; }, { threshold: 0 });
    io.observe(wrap);

    let raf = 0, clock = 0, last = performance.now(), nextSpawn = 1.0;
    const birds: Bird[] = [];
    let W = 0, H = 0, dpr = 1;

    const resize = () => {
      const cur = propsRef.current;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = wrap.clientWidth || 800; H = cur.height;
      const pw = Math.max(1, Math.round(W * dpr)), ph = Math.max(1, Math.round(H * dpr));
      if (hazeC.width !== pw || hazeC.height !== ph) { hazeC.width = pw; hazeC.height = ph; }
      if (birdC.width !== pw || birdC.height !== ph) { birdC.width = pw; birdC.height = ph; }
      gl.viewport(0, 0, pw, ph);
    };

    const spawn = () => {
      const y = (0.08 + Math.random() * 0.2) * H;
      birds.push({ x: -40, y, vx: 26 + Math.random() * 24, size: 6 + Math.random() * 7, phase: Math.random() * 6.28, flapSpeed: 5 + Math.random() * 3, arc: (Math.random() - 0.5) * 0.5, born: clock, alpha: 0.5 + Math.random() * 0.35 });
    };

    const drawBird = (b: Bird) => {
      const cur = propsRef.current;
      const flap = 0.5 + 0.5 * Math.sin((clock - b.born) * b.flapSpeed + b.phase);
      const w = b.size * dpr, lift = (0.3 + 0.6 * flap) * w, x = b.x * dpr, y = b.y * dpr;
      ctx.save();
      ctx.globalAlpha = b.alpha;
      ctx.strokeStyle = cur.birdColor;
      ctx.lineWidth = Math.max(1, w * 0.16);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x - w, y - lift * 0.15);
      ctx.quadraticCurveTo(x - w * 0.42, y - lift, x, y);
      ctx.quadraticCurveTo(x + w * 0.42, y - lift, x + w, y - lift * 0.15);
      ctx.stroke();
      ctx.restore();
    };

    const frame = (now: number) => {
      const cur = propsRef.current;
      const dt = Math.min((now - last) / 1000, 0.05); last = now;
      const playing = cur.autoPlay && !reduce && visible;
      if (playing) clock += dt;
      resize();

      const c = hexRaw(cur.hazeColor);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(U.time, clock * cur.hazeSpeed);
      gl.uniform2f(U.res, hazeC.width, hazeC.height);
      gl.uniform3f(U.color, c[0], c[1], c[2]);
      gl.uniform1f(U.opacity, cur.hazeOpacity);
      gl.uniform1f(U.speed, cur.hazeSpeed);
      gl.uniform1f(U.bandY, cur.hazeBandY);
      gl.uniform1f(U.bandH, cur.hazeBandH);
      gl.uniform1f(U.scale, cur.hazeScale);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      ctx.clearRect(0, 0, birdC.width, birdC.height);
      if (playing) {
        nextSpawn -= dt;
        if (nextSpawn <= 0 && birds.length < cur.maxBirds) { spawn(); nextSpawn = cur.birdRate * (0.6 + Math.random() * 0.8); }
        for (const b of birds) { b.x += b.vx * dt; b.y += b.arc * b.vx * dt; }
        for (let i = birds.length - 1; i >= 0; i--) if (birds[i].x > W + 50) birds.splice(i, 1);
      }
      for (const b of birds) drawBird(b);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const onResize = () => resize();
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(raf); io.disconnect(); window.removeEventListener('resize', onResize); gl.deleteProgram(prog); gl.deleteBuffer(buf); };

  }, []);

  return (
    <div ref={wrapRef} className={props.className} style={{ position: 'relative', width: '100%', height: p.height, overflow: 'hidden', ...props.style }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={p.src} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: p.objectPosition, display: 'block' }} />
      <canvas ref={hazeRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }} />
      <canvas ref={birdRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }} />
    </div>
  );
}

export default FooterImage;
