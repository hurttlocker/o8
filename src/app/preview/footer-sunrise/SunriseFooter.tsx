'use client';

/**
 * SunriseFooter — a procedural "Tuscan sunrise" footer scene.
 *
 * Recreates the reference look: warm amber gradient sky, a bright sun DISC
 * sitting just above the horizon, several LAYERED hazy ridges fading back via
 * atmospheric perspective, VALLEY FOG pooling between the ridges (drifting), a
 * lit golden GRASS foreground with a ragged rim, and infrequent distant birds.
 *
 * Dependency-free raw WebGL + a 2D bird layer. Authored from scratch.
 */

import { useEffect, useRef, type CSSProperties } from 'react';

export interface SunriseFooterProps {
  height?: number;
  /** Sky-gradient pivot + ridge anchor, fraction from bottom. */
  horizon?: number;
  sunX?: number;
  sunY?: number;
  /** Valley-fog amount 0..1.5. */
  fog?: number;
  /** Cloud/fog density + drift speed + feature scale. */
  density?: number;
  speed?: number;
  scale?: number;
  /** Grass top edge, fraction from bottom. */
  grassHeight?: number;
  birdRate?: number;
  maxBirds?: number;
  autoPlay?: boolean;
  className?: string;
  style?: CSSProperties;
}

const DEFAULTS = {
  height: 360,
  horizon: 0.52,
  sunX: 0.72,
  sunY: 0.55,
  fog: 1,
  density: 0.5,
  speed: 1,
  scale: 1,
  grassHeight: 0.16,
  birdRate: 5,
  maxBirds: 2,
  autoPlay: true,
};

// warm dawn palette (sRGB)
export const SUNRISE_PAL = {
  skyTop: '#edbe7f',
  skyHorizon: '#ffe7bd',
  sun: '#fff6df',
  fog: '#f3e4c8',
  rFar: '#94a1a7',
  rMid: '#7c8773',
  rNear: '#55604b',
  grass: '#6b5c2c',
  bird: '#2a241c',
};
const PAL = SUNRISE_PAL;

export const SUNRISE_VERT = `
attribute vec2 a_pos; varying vec2 v_uv;
void main(){ v_uv=a_pos*0.5+0.5; gl_Position=vec4(a_pos,0.0,1.0); }`;

export const SUNRISE_FRAG = `
precision highp float;
varying vec2 v_uv;
uniform float u_time; uniform vec2 u_res;
uniform vec3 u_skyTop,u_skyHorizon,u_sun,u_fog,u_rFar,u_rMid,u_rNear,u_grass;
uniform vec2 u_sunPos;
uniform float u_horizon,u_fogAmt,u_density,u_speed,u_scale,u_grassH;

float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p),f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y); }
float fbm(vec2 p){ float v=0.0,a=0.5; mat2 r=mat2(0.8,-0.6,0.6,0.8);
  for(int i=0;i<5;i++){ v+=a*noise(p); p=r*p*2.0+11.3; a*=0.5; } return v; }

float cloudBand(vec2 uv,float yC,float yW,float scale,float speed,float t,float dens){
  vec2 p=vec2(uv.x*scale - t*speed, uv.y*scale*1.5);
  p.y+=0.18*fbm(p*0.6 + t*0.04);
  float n=fbm(p);
  float band=exp(-pow((uv.y-yC)/yW,2.0));
  float cover=smoothstep(0.5-dens*0.32,0.86,n);
  return clamp(cover*band,0.0,1.0);
}

void main(){
  vec2 uv=v_uv; float t=u_time;
  float aspect=u_res.x/max(u_res.y,1.0);
  float scl=max(u_scale,0.2);

  // sky
  float g=smoothstep(u_horizon-0.12,1.0,uv.y);
  vec3 col=mix(u_skyHorizon,u_skyTop,g);

  // sun glow + disc
  vec2 d=uv-u_sunPos; d.x*=aspect; float dist=length(d);
  float glow=exp(-dot(d,d)*5.0);
  col=mix(col,u_sun,clamp(glow*0.85,0.0,1.0));
  float disc=smoothstep(0.052,0.044,dist);
  col=mix(col,u_sun*1.08,disc);

  // high clouds (subtle, warm)
  float c1=cloudBand(uv,u_horizon+0.30,0.22,2.4/scl,0.028,t,u_density);
  col=mix(col, mix(u_fog,u_sun,glow*0.6), clamp(c1*0.5,0.0,1.0));

  // far ridge (hazy, cool, atmospheric)
  float yFar=u_horizon-0.02 +0.03*sin(uv.x*2.6+0.3)+0.015*sin(uv.x*6.0+1.4);
  float mFar=smoothstep(yFar+0.006,yFar-0.006,uv.y);
  col=mix(col, mix(u_rFar,u_skyHorizon,0.38), mFar*0.9);

  // valley fog between far & mid — pools, lit warm near sun
  vec3 fogCol=mix(u_fog,u_sun,glow*0.55);
  float fogA=cloudBand(uv,u_horizon-0.05,0.075,4.5/scl,0.030,t,u_density)*u_fogAmt;
  col=mix(col,fogCol,clamp(fogA,0.0,1.0));

  // mid ridge
  float yMid=u_horizon-0.10 +0.04*sin(uv.x*3.3-0.7)+0.02*sin(uv.x*7.0+2.1);
  float mMid=smoothstep(yMid+0.006,yMid-0.006,uv.y);
  col=mix(col,u_rMid,mMid*0.95);

  // lower valley fog (thin, at near-ridge base)
  float fogB=cloudBand(uv,u_horizon-0.15,0.05,6.0/scl,0.04,t,u_density)*u_fogAmt*0.7;
  col=mix(col,fogCol,clamp(fogB,0.0,1.0));

  // near ridge (solid)
  float yNear=u_horizon-0.20 +0.05*sin(uv.x*2.1-1.2)+0.025*sin(uv.x*4.6+0.4);
  float mNear=smoothstep(yNear+0.006,yNear-0.006,uv.y);
  col=mix(col,u_rNear,mNear);

  // grass foreground with ragged lit rim
  float gtop=u_grassH + 0.012*fbm(vec2(uv.x*55.0, t*0.03));
  float mg=smoothstep(gtop+0.004,gtop-0.004,uv.y);
  vec3 gcol=u_grass;
  float rim=smoothstep(gtop-0.05,gtop,uv.y);
  gcol=mix(gcol,u_sun,rim*0.5*clamp(glow+0.25,0.0,1.0));
  col=mix(col,gcol,mg);
  float blades=smoothstep(0.66,0.95,fbm(vec2(uv.x*150.0 + t*0.08, uv.y*42.0)));
  col=mix(col, mix(gcol,u_sun,0.35), mg*rim*blades*0.4);

  gl_FragColor=vec4(col,1.0);
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
    console.error('[sunrise-footer] compile failed:', gl.getShaderInfoLog(sh));
    return null;
  }
  return sh;
}

interface Bird { x: number; y: number; vx: number; size: number; phase: number; flapSpeed: number; arc: number; born: number; alpha: number; }

export function SunriseFooter(props: SunriseFooterProps) {
  const p = { ...DEFAULTS, ...props };
  const skyRef = useRef<HTMLCanvasElement | null>(null);
  const birdRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(p);
  propsRef.current = p;

  useEffect(() => {
    const skyC = skyRef.current, birdC = birdRef.current, wrap = wrapRef.current;
    if (!skyC || !birdC || !wrap) return;
    const gl = skyC.getContext('webgl', { antialias: true, alpha: false });
    const ctx = birdC.getContext('2d');
    if (!gl || !ctx) { console.error('[sunrise-footer] context unavailable'); return; }

    const vs = compile(gl, gl.VERTEX_SHADER, SUNRISE_VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, SUNRISE_FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.error('[sunrise-footer] link failed', gl.getProgramInfoLog(prog)); return; }
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
      if (skyC.width !== pw || skyC.height !== ph) { skyC.width = pw; skyC.height = ph; }
      if (birdC.width !== pw || birdC.height !== ph) { birdC.width = pw; birdC.height = ph; }
      gl.viewport(0, 0, pw, ph);
    };

    const spawn = () => {
      const y = (0.08 + Math.random() * 0.18) * H;
      birds.push({ x: -40, y, vx: 24 + Math.random() * 22, size: 6 + Math.random() * 6, phase: Math.random() * 6.28, flapSpeed: 5 + Math.random() * 3, arc: (Math.random() - 0.5) * 0.5, born: clock, alpha: 0.45 + Math.random() * 0.35 });
    };
    const drawBird = (b: Bird) => {
      const flap = 0.5 + 0.5 * Math.sin((clock - b.born) * b.flapSpeed + b.phase);
      const w = b.size * dpr, lift = (0.3 + 0.6 * flap) * w, x = b.x * dpr, y = b.y * dpr;
      ctx.save();
      ctx.globalAlpha = b.alpha;
      ctx.strokeStyle = PAL.bird;
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

      gl.uniform1f(U.time, clock * cur.speed);
      gl.uniform2f(U.res, skyC.width, skyC.height);
      set3(U.skyTop, PAL.skyTop); set3(U.skyHorizon, PAL.skyHorizon); set3(U.sun, PAL.sun);
      set3(U.fog, PAL.fog); set3(U.rFar, PAL.rFar); set3(U.rMid, PAL.rMid); set3(U.rNear, PAL.rNear); set3(U.grass, PAL.grass);
      gl.uniform2f(U.sunPos, cur.sunX, cur.sunY);
      gl.uniform1f(U.horizon, cur.horizon);
      gl.uniform1f(U.fogAmt, cur.fog);
      gl.uniform1f(U.density, cur.density);
      gl.uniform1f(U.speed, cur.speed);
      gl.uniform1f(U.scale, cur.scale);
      gl.uniform1f(U.grassH, cur.grassHeight);
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
      <canvas ref={skyRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />
      <canvas ref={birdRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }} />
    </div>
  );
}

export default SunriseFooter;
