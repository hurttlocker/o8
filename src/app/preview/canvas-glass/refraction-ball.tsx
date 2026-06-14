'use client';

/**
 * RefractionBall (#1239) — the WebGL innards of the NavigatorLoupe crystal ball.
 *
 * Two-pass SPHERE PROJECTION. The cards near you are painted flat to an
 * offscreen 2D canvas (image cards via drawImage of their thumbnail, every other
 * kind as a tinted rounded tile — same mapping as the CSS minimap). Then:
 *
 *   Pass 1 — render that flat content layer onto a SUBDIVIDED MESH whose vertices
 *     are projected onto a hemisphere (ρ' = sin(ρ·k)/k, z = cos(ρ·k)) into an
 *     offscreen framebuffer. Because the GEOMETRY bends, the content genuinely
 *     foreshortens: a card near the rim shrinks + curls — and so does a SOLID
 *     card, because its boundary is real geometry, not a flat-field UV sample.
 *   Pass 2 — draw the glass shell over it on a full-screen quad: round mask,
 *     sphere lighting, specular, a rim chromatic fringe, a grazing edge, and the
 *     smooth content dissolve at the rim.
 *
 * The earlier single-pass 2D UV-remap "lens" (asin radial remap) could curve a
 * card's borders but never make one edge cover more pixels than the other
 * (foreshortening), and was invisible on solid cards — hence this rewrite.
 *
 * The card → ball mapping matches the old CSS minimap math:
 *   x = ox + (card.x - area.x) * scale,  scale = min(inner/area.w, inner/area.h).
 */

import { useCallback, useEffect, useRef } from 'react';
import type { MinimapCard } from './navigator-loupe';
import { ORB_DEFAULTS, type OrbSettings } from './orb-settings';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Mesh subdivision — N×N quads tessellating the content plane. The projection is
// nonlinear so the quad must be subdivided to bend smoothly; N≈14 is plenty
// smooth at the compressed rim for a ~220px ball and trivially cheap.
const MESH_N = 14;

// ── Shaders ────────────────────────────────────────────────────────────────

// Pass 1 vertex — a_grid ∈ [0,1]² is BOTH the plane position and the texcoord.
// tangent ∈ [-1,1]² is the flat content disc; we project it onto the hemisphere
// and output the projected position, sampling the flat content at the ORIGINAL
// (un-projected) texcoord so each texel travels with its geometry. The guard
// keeps it exactly flat at u_k → 0 (used to de-risk the pipeline).
const MESH_VERT = `
attribute vec2 a_grid;
uniform float u_k;       // hemisphere curvature (wrap) — 0 = flat
uniform float u_fill;    // radial fill — push content out toward the rim
uniform float u_mag;     // centre magnification (lens swell)
varying vec2 v_uv;
varying float v_z;
void main() {
  vec2 tangent = a_grid * 2.0 - 1.0;
  float rho = length(tangent);
  float s = min(rho * u_k, 3.0);                       // clamp < π so sin never folds
  float rprime = (u_k > 1e-4) ? sin(s) / u_k : rho;    // ρ'/ρ → 1 at centre, flat at k=0
  float scale = (rho > 1e-4) ? rprime / rho : 1.0;
  scale *= u_fill;
  scale *= 1.0 + u_mag * (1.0 - smoothstep(0.0, 0.85, rho));   // centre swell
  vec2 pos = tangent * scale;
  v_uv = a_grid;
  v_z = cos(s);
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

// Pass 1 fragment — straight-alpha content. Body luminosity + a depth cue
// (nearer-to-glass reads brighter) move here from the old shell. The FBO uses a
// separate blend func for the alpha channel so straight alpha composites right.
const MESH_FRAG = `
precision highp float;
varying vec2 v_uv;
varying float v_z;
uniform sampler2D u_tex;
uniform float u_glass;   // body luminosity
uniform float u_depth;   // depth shading — far content sits back / dims
void main() {
  vec4 c = texture2D(u_tex, v_uv);
  if (c.a < 0.003) discard;
  vec3 rgb = c.rgb;
  rgb *= 0.80 + 0.40 * u_glass;
  rgb *= 1.0 - 0.18 * u_depth * (1.0 - v_z);
  gl_FragColor = vec4(rgb, c.a);
}`;

// Pass 2 vertex — full-screen quad.
const SHELL_VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// Pass 2 fragment — glass shell over the projected content. Content is already
// sphere-correct, so we sample it straight (no UV-remap lens); we keep a whisper
// of rim-weighted chromatic dispersion (the chroma dial), the round mask, sphere
// lighting, specular, the rim chroma fringe, the grazing edge, and the smooth
// content dissolve at the rim.
const SHELL_FRAG = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;   // FBO: sphere-projected content (straight alpha)
uniform float u_aberr;     // chroma — radial dispersion, pinned to the rim
uniform float u_spec;      // specular hotspot
uniform float u_rim;       // rim rainbow fringe
const vec3 LIGHT = vec3(-0.42, 0.55, 0.72);   // upper-left, toward viewer
void main() {
  vec2 p = (v_uv - 0.5) * 2.0;          // -1..1 across the sphere
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;                 // round mask
  float r = sqrt(r2);
  float z = sqrt(1.0 - r2);              // hemisphere height
  vec3 N = normalize(vec3(p, z));        // sphere normal facing the viewer
  vec2 dir = r > 1e-4 ? p / r : vec2(0.0);

  // Chromatic dispersion — only a whisper, pinned to the very rim (pow(r,6)) so
  // there's NO colour blur through the middle; a hint of glass at the edge.
  float ab = u_aberr * pow(r, 6.0) * 0.5;
  vec2 cao = dir * ab;
  vec4 cr = texture2D(u_tex, v_uv + cao);
  vec4 cg = texture2D(u_tex, v_uv);
  vec4 cb = texture2D(u_tex, v_uv - cao);
  vec3 content = vec3(cr.r, cg.g, cb.b);
  float contentA = max(cr.a, max(cg.a, cb.a));
  // Smooth exit — a card that scrolls out of the ball DISSOLVES over the outer
  // ~16% instead of popping at a hard boundary.
  float fade = smoothstep(1.0, 0.84, r);
  content *= fade;
  contentA *= fade;

  // Glass shell — a broad specular sweep, a single smooth rim fringe that
  // intensifies toward the rim, and a bright grazing edge at the very lip.
  float ndl = max(0.0, dot(N, normalize(LIGHT)));
  float spec = pow(ndl, 42.0) * u_spec * 1.3;
  float ang = atan(p.y, p.x);
  float rimGrad = pow(smoothstep(0.85, 1.0, r), 2.4);
  vec3 fringe = (0.5 + 0.5 * cos(vec3(0.0, 2.094, 4.188) + ang * 1.4 + r * 20.0)) * rimGrad * u_rim;
  // Grazing edge + rim alpha are FULLY rim-glow-driven — no baseline ring. At
  // Rim glow ≈ 0 the glass edge disappears entirely (only content + clear glass
  // remain); the operator drives the whole edge treatment via the dials.
  float edge = pow(smoothstep(0.90, 1.0, r), 2.5) * u_rim;

  vec3 glassLight = vec3(spec) + fringe + vec3(edge);
  float glassA = clamp(spec * 0.9 + rimGrad * u_rim * 0.6 + edge * 0.85, 0.0, 1.0);

  // Composite — content over the clear canvas behind, glass shell added on top.
  vec3 outRgb = clamp(content + glassLight, 0.0, 1.0);
  float outA = clamp(max(contentA, glassA), 0.0, 1.0) * smoothstep(1.0, 0.96, r);
  gl_FragColor = vec4(outRgb, outA);
}`;

const KIND_TINT: Record<string, string> = {
  term: '#2c313d',
  file: '#8aa0bf',
  browser: '#6f8bd0',
  chat: '#56c0a6',
  diff: '#c9a35c',
  spec: '#9b8ad0',
  brain: '#cf7ab0',
};

// ── GL state ─────────────────────────────────────────────────────────────────

interface MeshProgram {
  program: WebGLProgram;
  aGrid: number;
  uTex: WebGLUniformLocation | null;
  uK: WebGLUniformLocation | null;
  uFill: WebGLUniformLocation | null;
  uMag: WebGLUniformLocation | null;
  uGlass: WebGLUniformLocation | null;
  uDepth: WebGLUniformLocation | null;
}

interface ShellProgram {
  program: WebGLProgram;
  aPos: number;
  uTex: WebGLUniformLocation | null;
  uAberr: WebGLUniformLocation | null;
  uSpec: WebGLUniformLocation | null;
  uRim: WebGLUniformLocation | null;
}

interface GLState {
  gl: WebGLRenderingContext;
  mesh: MeshProgram;
  shell: ShellProgram;
  contentTex: WebGLTexture;       // uploaded from texCanvas each frame
  texCanvas: HTMLCanvasElement;
  texCtx: CanvasRenderingContext2D;
  fbo: WebGLFramebuffer;
  fboTex: WebGLTexture;
  gridBuffer: WebGLBuffer;        // a_grid vertices
  indexBuffer: WebGLBuffer;       // mesh triangle indices
  indexCount: number;
  quadBuffer: WebGLBuffer;        // full-screen quad (shell)
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('[refraction-ball] shader compile failed:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function link(gl: WebGLRenderingContext, vsSrc: string, fsSrc: string): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('[refraction-ball] program link failed:', gl.getProgramInfoLog(program));
    return null;
  }
  return program;
}

/** Build the static N×N subdivided unit quad (positions + triangle indices). */
function buildGrid(n: number): { verts: Float32Array; idx: Uint16Array } {
  const verts: number[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) verts.push(i / n, j / n);
  }
  const idx: number[] = [];
  const row = n + 1;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * row + i;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  return { verts: new Float32Array(verts), idx: new Uint16Array(idx) };
}

function makeTex(gl: WebGLRenderingContext): WebGLTexture | null {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

function initGL(canvas: HTMLCanvasElement): GLState | null {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    premultipliedAlpha: false,
    antialias: true,
    depth: false,
  }) as WebGLRenderingContext | null;
  if (!gl) return null;

  const meshProgram = link(gl, MESH_VERT, MESH_FRAG);
  const shellProgram = link(gl, SHELL_VERT, SHELL_FRAG);
  if (!meshProgram || !shellProgram) return null;

  // Mesh geometry — the subdivided quad.
  const { verts, idx } = buildGrid(MESH_N);
  const gridBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, gridBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  const indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

  // Full-screen quad — the glass shell.
  const quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  // Content texture (the offscreen 2D canvas). FLIP_Y so the painted canvas
  // (origin top-left) maps right-side-up onto the mesh; only DOM-source uploads
  // honour this, so the null-allocated FBO texture is unaffected.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  const contentTex = makeTex(gl);
  if (!contentTex) return null;

  // Offscreen framebuffer + its colour texture (sized on first resize).
  const fboTex = makeTex(gl);
  const fbo = gl.createFramebuffer();
  if (!fboTex || !fbo) return null;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  gl.enable(gl.BLEND);

  const texCanvas = document.createElement('canvas');
  const texCtx = texCanvas.getContext('2d');
  if (!texCtx) return null;

  return {
    gl,
    mesh: {
      program: meshProgram,
      aGrid: gl.getAttribLocation(meshProgram, 'a_grid'),
      uTex: gl.getUniformLocation(meshProgram, 'u_tex'),
      uK: gl.getUniformLocation(meshProgram, 'u_k'),
      uFill: gl.getUniformLocation(meshProgram, 'u_fill'),
      uMag: gl.getUniformLocation(meshProgram, 'u_mag'),
      uGlass: gl.getUniformLocation(meshProgram, 'u_glass'),
      uDepth: gl.getUniformLocation(meshProgram, 'u_depth'),
    },
    shell: {
      program: shellProgram,
      aPos: gl.getAttribLocation(shellProgram, 'a_pos'),
      uTex: gl.getUniformLocation(shellProgram, 'u_tex'),
      uAberr: gl.getUniformLocation(shellProgram, 'u_aberr'),
      uSpec: gl.getUniformLocation(shellProgram, 'u_spec'),
      uRim: gl.getUniformLocation(shellProgram, 'u_rim'),
    },
    contentTex,
    texCanvas,
    texCtx,
    fbo,
    fboTex,
    gridBuffer,
    indexBuffer,
    indexCount: idx.length,
    quadBuffer,
  };
}

// ── 2D texture painting (unchanged — the content layer) ──────────────────────

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function drawImageCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, dx: number, dy: number, dw: number, dh: number) {
  const ir = img.naturalWidth / img.naturalHeight;
  const tr = dw / dh;
  let sx: number, sy: number, sw: number, sh: number;
  if (ir > tr) {
    sh = img.naturalHeight;
    sw = sh * tr;
    sx = (img.naturalWidth - sw) / 2;
    sy = 0;
  } else {
    sw = img.naturalWidth;
    sh = sw / tr;
    sx = 0;
    sy = (img.naturalHeight - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

function getImage(cache: Map<string, HTMLImageElement>, src: string, onLoad: () => void): HTMLImageElement {
  const existing = cache.get(src);
  if (existing) return existing;
  const img = new Image();
  if (/^https?:/i.test(src)) img.crossOrigin = 'anonymous';
  img.onload = onLoad;
  img.onerror = () => { /* leave it; the tile placeholder covers it */ };
  img.src = src;
  cache.set(src, img);
  return img;
}

function paintTexture(
  ctx: CanvasRenderingContext2D,
  texPx: number,
  cards: MinimapCard[],
  area: Rect,
  cache: Map<string, HTMLImageElement>,
  onImageLoad: () => void,
  fog: number,
) {
  ctx.clearRect(0, 0, texPx, texPx);
  // Fog drives the interior OPACITY: at 0 it's fully transparent (clear glass —
  // the canvas shows through and the cards float), ramping to opaque milky at 1.
  const f = Math.min(1, Math.max(0, fog));
  if (f > 0.002) {
    const g = ctx.createLinearGradient(0, 0, 0, texPx);
    g.addColorStop(0, '#f4f6fa');
    g.addColorStop(1, '#e6ebf3');
    ctx.globalAlpha = f;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, texPx, texPx);
    ctx.globalAlpha = 1;
  }

  if (area.w <= 0 || area.h <= 0) return;
  const pad = texPx * 0.05;
  const inner = texPx - pad * 2;
  const scale = Math.min(inner / area.w, inner / area.h);
  const ox = (texPx - area.w * scale) / 2;
  const oy = (texPx - area.h * scale) / 2;

  for (const card of cards) {
    const x = ox + (card.x - area.x) * scale;
    const y = oy + (card.y - area.y) * scale;
    const w = Math.max(3, card.w * scale);
    const h = Math.max(3, card.h * scale);
    const rad = Math.min(5, w * 0.2, h * 0.2);

    if (card.src) {
      const img = getImage(cache, card.src, onImageLoad);
      if (img.complete && img.naturalWidth > 0) {
        ctx.save();
        roundRectPath(ctx, x, y, w, h, rad);
        ctx.clip();
        drawImageCover(ctx, img, x, y, w, h);
        ctx.restore();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.12)';
        roundRectPath(ctx, x, y, w, h, rad);
        ctx.stroke();
        continue;
      }
      // Not ready yet → tile placeholder below; onImageLoad triggers a redraw.
    }

    ctx.fillStyle = KIND_TINT[card.kind] || '#7d8aa0';
    roundRectPath(ctx, x, y, w, h, rad);
    ctx.fill();
    // Top-edge highlight so tiles read as lit panels, not flat blocks.
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    roundRectPath(ctx, x, y, w, Math.max(2, h * 0.3), rad);
    ctx.fill();
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export function RefractionBall({ cards, area, size, settings = ORB_DEFAULTS }: { cards: MinimapCard[]; area: Rect; size: number; settings?: OrbSettings }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<GLState | null>(null);
  const cacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const propsRef = useRef({ cards, area, size, settings });
  propsRef.current = { cards, area, size, settings };
  const rafRef = useRef(0);
  const sizeRef = useRef(0);

  // Stable scheduler → latest draw closure (avoids re-creating the GL program).
  const scheduleFrame = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      drawRef.current();
    });
  }, []);

  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    const state = stateRef.current;
    if (!state) return;
    const { gl, mesh, shell, contentTex, texCanvas, texCtx, fbo, fboTex } = state;
    const { cards: c, area: a, settings: s } = propsRef.current;
    const px = texCanvas.width;
    if (px < 1) return;

    // Paint the flat content layer + upload it.
    paintTexture(texCtx, px, c, a, cacheRef.current, scheduleFrame, s.fog);
    gl.bindTexture(gl.TEXTURE_2D, contentTex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, texCanvas);
    } catch {
      // A cross-origin image tainted the canvas — keep the last good texture.
    }

    // ── Dial → projection mapping ──
    // wrap = curvature: how hard cards foreshorten + shrink as they near the rim
    // (the real "wrap" — NOT overall zoom); edge = how far content spreads toward
    // the rim (fill / overall size); magnify = centre swell.
    // Coverage clamp (#1 risk): a single ball-filling card would bend into an
    // unreadable fisheye, so soften the curvature as the largest card's span
    // approaches the full disc — keeps a big card flat in its centre, curling
    // only its outer margin, while many small cards still get the full wrap.
    let maxFrac = 0;
    if (a.w > 0 && a.h > 0) {
      const sc = Math.min((px * 0.9) / a.w, (px * 0.9) / a.h);
      for (const card of c) {
        const f = (Math.max(card.w, card.h) * sc) / px;
        if (f > maxFrac) maxFrac = f;
      }
    }
    const coverageClamp = 1 - Math.min(1, maxFrac) * 0.5;
    const uK = (0.3 + s.wrap * 0.7) * coverageClamp;
    const uFill = 0.6 + s.edge * 0.55;
    const uMag = s.magnify;

    // Pass 1 — content mesh → FBO. Separate alpha blend keeps straight alpha
    // composited correctly into the render target.
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, px, px);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(mesh.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.gridBuffer);
    gl.enableVertexAttribArray(mesh.aGrid);
    gl.vertexAttribPointer(mesh.aGrid, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, state.indexBuffer);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, contentTex);
    gl.uniform1i(mesh.uTex, 0);
    gl.uniform1f(mesh.uK, uK);
    gl.uniform1f(mesh.uFill, uFill);
    gl.uniform1f(mesh.uMag, uMag);
    gl.uniform1f(mesh.uGlass, s.glass);
    gl.uniform1f(mesh.uDepth, s.depth);
    gl.drawElements(gl.TRIANGLES, state.indexCount, gl.UNSIGNED_SHORT, 0);

    // Pass 2 — glass shell → canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, px, px);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(shell.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.quadBuffer);
    gl.enableVertexAttribArray(shell.aPos);
    gl.vertexAttribPointer(shell.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fboTex);
    gl.uniform1i(shell.uTex, 0);
    gl.uniform1f(shell.uAberr, s.chroma);
    gl.uniform1f(shell.uSpec, s.specular);
    gl.uniform1f(shell.uRim, s.rim);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  // Init GL once and keep it for the component's life. We deliberately do NOT
  // lose the context on cleanup: getContext('webgl') cannot revive a lost
  // context on the same <canvas>, so losing it would break React StrictMode's
  // setup→cleanup→setup remount (and Fast Refresh) — the remount would reuse a
  // dead context and the ball would render blank. The guard makes re-setup a
  // no-op; the GPU context is reclaimed when the canvas is GC'd on true unmount.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!stateRef.current) {
      const state = initGL(canvas);
      if (!state) {
        console.warn('[refraction-ball] WebGL unavailable — ball will be transparent');
        return;
      }
      stateRef.current = state;
    }
    scheduleFrame();
    return () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [scheduleFrame]);

  // Resize the backing store + FBO on size/dpr change; redraw on any prop change.
  useEffect(() => {
    const state = stateRef.current;
    const canvas = canvasRef.current;
    if (!state || !canvas) return;
    if (sizeRef.current !== size) {
      sizeRef.current = size;
      const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
      const px = Math.max(1, Math.round(size * dpr));
      canvas.width = px;
      canvas.height = px;
      state.texCanvas.width = px;
      state.texCanvas.height = px;
      // Resize the FBO colour texture to match.
      state.gl.bindTexture(state.gl.TEXTURE_2D, state.fboTex);
      state.gl.texImage2D(state.gl.TEXTURE_2D, 0, state.gl.RGBA, px, px, 0, state.gl.RGBA, state.gl.UNSIGNED_BYTE, null);
    }
    scheduleFrame();
  }, [cards, area, size, settings, scheduleFrame]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', borderRadius: '50%', display: 'block', pointerEvents: 'none' }}
    />
  );
}
