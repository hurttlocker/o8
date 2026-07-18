'use client';

/**
 * FooterScene — a calm, premium animated background for a site footer.
 *
 * Layers (back → front):
 *   1. WebGL sky: vertical gradient + warm sun glow near the horizon.
 *   2. WebGL clouds/mist: 2–3 parallax bands of drifting fBm noise with a slow
 *      vertical "breathing" warp; a denser mist band hugs the horizon.
 *   3. WebGL hills: two layered sine-ridge silhouettes (hazy back, solid front)
 *      with atmospheric blend into the horizon.
 *   4. 2D birds: infrequent solitary silhouettes that flap and arc left → right.
 *
 * Recreates the mechanics of the reference footer (drifting volumetric mist +
 * lone arcing birds) — authored from scratch, no copied code. Dependency-free
 * raw WebGL, matching the repo convention. All character lives in props so the
 * lab page can tune it on sliders.
 */

import { useEffect, useRef, type CSSProperties } from 'react';

export interface FooterScenePalette {
  skyTop: string;
  skyHorizon: string;
  sunColor: string;
  cloudColor: string;
  hillBack: string;
  hillFront: string;
  birdColor: string;
}

export interface FooterSceneProps {
  palette?: FooterScenePalette;
  height?: number;
  /** Horizon line, fraction of height from the BOTTOM. */
  horizon?: number;
  /** Sun position in 0..1 uv (x left→right, y bottom→top). */
  sunX?: number;
  sunY?: number;
  /** Cloud coverage 0 (clear) … 1 (overcast). */
  mistDensity?: number;
  /** Cloud horizontal drift speed. */
  mistSpeed?: number;
  /** Cloud feature size (bigger = larger, softer masses). */
  cloudScale?: number;
  /** Show the layered hill silhouettes. */
  hills?: boolean;
  /** Average seconds between bird spawns. */
  birdRate?: number;
  /** Max birds visible at once. */
  maxBirds?: number;
  autoPlay?: boolean;
  className?: string;
  style?: CSSProperties;
}

export const O8_DAY: FooterScenePalette = {
  skyTop: '#a9d8ff',
  skyHorizon: '#eaf6ff',
  sunColor: '#fff6dd',
  cloudColor: '#ffffff',
  hillBack: '#bfe0c0',
  hillFront: '#8ec792',
  birdColor: '#3a4a55',
};

export const GOLDEN_HOUR: FooterScenePalette = {
  skyTop: '#e9a978',
  skyHorizon: '#ffe6bf',
  sunColor: '#fff1cf',
  cloudColor: '#ffd9ad',
  hillBack: '#8d7a63',
  hillFront: '#5a4d42',
  birdColor: '#241c16',
};

export const DUSK: FooterScenePalette = {
  skyTop: '#3b3b6b',
  skyHorizon: '#d98a8a',
  sunColor: '#ffd2b0',
  cloudColor: '#b9a6c9',
  hillBack: '#4a466b',
  hillFront: '#2c2a45',
  birdColor: '#17131f',
};

const DEFAULTS = {
  palette: O8_DAY,
  height: 320,
  horizon: 0.34,
  sunX: 0.74,
  sunY: 0.42,
  mistDensity: 0.55,
  mistSpeed: 1,
  cloudScale: 1,
  hills: true,
  birdRate: 4,
  maxBirds: 2,
  autoPlay: true,
};

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
varying vec2 v_uv;
uniform float u_time;
uniform vec2  u_res;
uniform vec3  u_skyTop;
uniform vec3  u_skyHorizon;
uniform vec3  u_sun;
uniform vec3  u_cloud;
uniform vec3  u_hillBack;
uniform vec3  u_hillFront;
uniform vec2  u_sunPos;
uniform float u_horizon;
uniform float u_density;
uniform float u_speed;
uniform float u_cloudScale;
uniform float u_hills;

float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){
  vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);
}
float fbm(vec2 p){
  float v=0.0, a=0.5; mat2 r=mat2(0.8,-0.6,0.6,0.8);
  for(int i=0;i<5;i++){ v+=a*noise(p); p=r*p*2.0+11.3; a*=0.5; }
  return v;
}

// one drifting cloud band -> coverage 0..1
float cloudBand(vec2 uv, float yC, float yW, float scale, float speed, float t){
  vec2 p = vec2(uv.x*scale - t*speed, uv.y*scale*1.6);
  // slow vertical breathing warp
  p.y += 0.15*fbm(p*0.6 + t*0.05);
  float n = fbm(p);
  float band = exp(-pow((uv.y - yC)/yW, 2.0));        // vertical envelope
  float cover = smoothstep(0.52 - u_density*0.34, 0.86, n);
  return clamp(cover * band, 0.0, 1.0);
}

void main(){
  vec2 uv = v_uv;                                     // y up
  float t = u_time;

  // --- sky gradient ---
  float g = smoothstep(u_horizon, 1.0, uv.y);
  vec3 sky = mix(u_skyHorizon, u_skyTop, g);

  // --- sun glow ---
  float aspect = u_res.x/max(u_res.y,1.0);
  vec2 d = (uv - u_sunPos); d.x *= aspect;
  float sun = exp(-dot(d,d)*7.0);
  sky += u_sun * sun * 0.65;
  sky = mix(sky, u_sun, smoothstep(0.05,0.0,length(d))*0.45);

  // --- clouds (parallax bands) ---
  float scl = max(u_cloudScale,0.2);
  float c1 = cloudBand(uv, u_horizon+0.42, 0.30, 2.2/scl, 0.030, t); // high slow
  float c2 = cloudBand(uv, u_horizon+0.20, 0.16, 4.0/scl, 0.060, t); // mid
  float mist = cloudBand(uv, u_horizon+0.02, 0.10, 5.5/scl, 0.045, t)*1.15; // low haze
  vec3 col = sky;
  // clouds pick up warm sun tint
  vec3 cloudTint = mix(u_cloud, u_sun, sun*0.6);
  col = mix(col, cloudTint, clamp(c1*0.85,0.0,1.0));
  col = mix(col, cloudTint, clamp(c2*0.9,0.0,1.0));
  col = mix(col, mix(cloudTint, u_skyHorizon, 0.25), clamp(mist,0.0,1.0));

  // --- hills ---
  if(u_hills > 0.5){
    // back hill (hazy)
    float hb = u_horizon - 0.02
      + 0.045*sin(uv.x*3.1 + 0.6)
      + 0.025*sin(uv.x*7.3 + 2.0);
    float mB = smoothstep(hb+0.006, hb-0.006, uv.y);
    vec3 hbCol = mix(u_hillBack, u_skyHorizon, 0.35);   // atmospheric haze
    col = mix(col, hbCol, mB*0.9);
    // front hill (solid)
    float hf = u_horizon - 0.10
      + 0.06*sin(uv.x*2.2 - 1.1)
      + 0.03*sin(uv.x*5.0 + 0.3);
    float mF = smoothstep(hf+0.006, hf-0.006, uv.y);
    col = mix(col, u_hillFront, mF);
  }

  gl_FragColor = vec4(col, 1.0);
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
    console.error('[footer-scene] compile failed:', gl.getShaderInfoLog(sh));
    return null;
  }
  return sh;
}

interface Bird {
  x: number; y: number; vx: number;
  size: number; phase: number; flapSpeed: number;
  arc: number; born: number; alpha: number;
}

export function FooterScene(props: FooterSceneProps) {
  const p = { ...DEFAULTS, ...props, palette: { ...DEFAULTS.palette, ...props.palette } };
  const skyRef = useRef<HTMLCanvasElement | null>(null);
  const birdRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(p);
  propsRef.current = p;

  useEffect(() => {
    const sky = skyRef.current;
    const birdCanvas = birdRef.current;
    const wrap = wrapRef.current;
    if (!sky || !birdCanvas || !wrap) return;

    const gl = sky.getContext('webgl', { antialias: true, alpha: false });
    const ctx = birdCanvas.getContext('2d');
    if (!gl || !ctx) {
      console.error('[footer-scene] context unavailable');
      return;
    }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('[footer-scene] link failed:', gl.getProgramInfoLog(prog));
      return;
    }
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
      sun: u('u_sun'), cloud: u('u_cloud'), hillBack: u('u_hillBack'), hillFront: u('u_hillFront'),
      sunPos: u('u_sunPos'), horizon: u('u_horizon'), density: u('u_density'), speed: u('u_speed'),
      cloudScale: u('u_cloudScale'), hills: u('u_hills'),
    };

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let visible = true;
    const io = new IntersectionObserver((e) => { visible = e[0]?.isIntersecting ?? true; }, { threshold: 0 });
    io.observe(wrap);

    let raf = 0, clock = 0, last = performance.now(), nextSpawn = 0.6;
    const birds: Bird[] = [];
    let W = 0, H = 0, dpr = 1;

    const resize = () => {
      const cur = propsRef.current;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = wrap.clientWidth || 800;
      H = cur.height;
      const pw = Math.max(1, Math.round(W * dpr));
      const ph = Math.max(1, Math.round(H * dpr));
      if (sky.width !== pw || sky.height !== ph) { sky.width = pw; sky.height = ph; }
      if (birdCanvas.width !== pw || birdCanvas.height !== ph) { birdCanvas.width = pw; birdCanvas.height = ph; }
      gl.viewport(0, 0, pw, ph);
    };

    const spawn = () => {
      // upper sky band, well clear of the footer content below
      const y = (0.08 + Math.random() * 0.22) * H;
      const size = 7 + Math.random() * 8;
      birds.push({
        x: -40, y, vx: (28 + Math.random() * 26),
        size, phase: Math.random() * Math.PI * 2,
        flapSpeed: 5 + Math.random() * 3,
        arc: (Math.random() - 0.5) * 0.6,
        born: clock, alpha: 0.55 + Math.random() * 0.35,
      });
    };

    const drawBird = (b: Bird) => {
      const cur = propsRef.current;
      const flap = 0.5 + 0.5 * Math.sin((clock - b.born) * b.flapSpeed + b.phase);
      const w = b.size * dpr;
      const lift = (0.3 + 0.6 * flap) * w;
      const x = b.x * dpr, y = b.y * dpr;
      ctx.save();
      ctx.globalAlpha = b.alpha;
      ctx.strokeStyle = cur.palette.birdColor;
      ctx.lineWidth = Math.max(1, w * 0.16);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x - w, y - lift * 0.15);
      ctx.quadraticCurveTo(x - w * 0.42, y - lift, x, y);
      ctx.quadraticCurveTo(x + w * 0.42, y - lift, x + w, y - lift * 0.15);
      ctx.stroke();
      ctx.restore();
    };

    const frame = (now: number) => {
      const cur = propsRef.current;
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const playing = cur.autoPlay && !reduce && visible;
      if (playing) clock += dt;

      resize();
      const pal = cur.palette;
      const set3 = (l: WebGLUniformLocation | null, hex: string) => { const c = hexRaw(hex); gl.uniform3f(l, c[0], c[1], c[2]); };
      gl.uniform1f(U.time, clock * cur.mistSpeed);
      gl.uniform2f(U.res, sky.width, sky.height);
      set3(U.skyTop, pal.skyTop); set3(U.skyHorizon, pal.skyHorizon); set3(U.sun, pal.sunColor);
      set3(U.cloud, pal.cloudColor); set3(U.hillBack, pal.hillBack); set3(U.hillFront, pal.hillFront);
      gl.uniform2f(U.sunPos, cur.sunX, cur.sunY);
      gl.uniform1f(U.horizon, cur.horizon);
      gl.uniform1f(U.density, cur.mistDensity);
      gl.uniform1f(U.speed, cur.mistSpeed);
      gl.uniform1f(U.cloudScale, cur.cloudScale);
      gl.uniform1f(U.hills, cur.hills ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // birds
      ctx.clearRect(0, 0, birdCanvas.width, birdCanvas.height);
      if (playing) {
        nextSpawn -= dt;
        if (nextSpawn <= 0 && birds.length < cur.maxBirds) {
          spawn();
          nextSpawn = cur.birdRate * (0.6 + Math.random() * 0.8);
        }
        for (const b of birds) {
          b.x += b.vx * dt;
          b.y += b.arc * b.vx * dt;
        }
        for (let i = birds.length - 1; i >= 0; i--) if (birds[i].x > W + 50) birds.splice(i, 1);
      }
      for (const b of birds) drawBird(b);

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const onResize = () => resize();
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener('resize', onResize);
      gl.deleteProgram(prog); gl.deleteBuffer(buf);
    };

  }, []);

  return (
    <div
      ref={wrapRef}
      className={props.className}
      style={{ position: 'relative', width: '100%', height: p.height, overflow: 'hidden', ...props.style }}
    >
      <canvas ref={skyRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />
      <canvas ref={birdRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }} />
    </div>
  );
}

export default FooterScene;
