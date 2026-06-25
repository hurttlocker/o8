# Canvas navigator globe — the real "liquid glass" look

**Status:** implementation note for a fleet agent · written 2026-06-24
**Target surface:** the circular canvas navigator ("globe") — `RefractionBall` inside `NavigatorLoupe`
**Goal:** make the globe read as a real, thick, Apple-style **liquid-glass lens** (the look in the reference shot below), not a rainbow crystal ball.

---

## TL;DR

- The globe is **`src/app/preview/canvas-glass/refraction-ball.tsx`** — a **WebGL** component (two-pass sphere projection). The glass look lives in the **GLSL shaders there**, not in CSS. Do the work in `MESH_VERT` (the lens geometry) and `SHELL_FRAG` (the glass shell).
- **Do NOT reach for `backdrop-filter: url(#svgFilter)`.** The app runs in a **Tauri = WebKit webview**, and WebKit does not support SVG-filter references in `backdrop-filter`. WebGL is the *correct* tool here precisely because of that — keep it.
- The reference "real glass" technique (Outpace Studios) is a **flat centre + a Snell-refracted rim band** — most of the surface is undistorted, the bending happens in a band near the edge. The globe today is a **full hemisphere** (fisheye), which is why it reads "marble" instead of "thick glass."
- The canvas is a **light/white paper** surface. The dark-theme rim trick (brighten with white) **inverts** here: a bright-only rim disappears on white. The edge needs a bright specular highlight **plus** a faint refraction/contact darkening to be legible.

---

## The look we're matching

Validated on the marketing site (o8-site) for the nav pills — same optical recipe, different shape. Source of truth for the math:

- **Writeup:** https://glass.outpacestudios.com/ (Outpace Studios, "Liquid Glass for Web")
- **Working o8-site code:** `o8-site/app/components/glass/liquid-glass.ts` (the dome math) and `useGlassPill.tsx` (the values we shipped). That implementation refracts via SVG `feDisplacementMap` because the site is viewed in Chrome; **the globe must NOT copy the SVG path** (WebKit), only the *optics*.

The optical model, in one paragraph: the surface is a **convex squircle/spherical dome — flat in the centre, curving through a rim band.** Light bends by **Snell's law at refractive index ≈ 1.5**, so the bend is **zero at the centre and maximal at the rim**. That produces: undistorted content in the middle, magnification + bowing concentrated at the edge, a **bright bevelled rim** (specular), and a **thin clean chromatic split** (red one way, blue the other) only at the very edge — never a multi-cycle rainbow through the body.

### Reference (what the operator wants)
A glass loupe sitting on the white canvas: thumbnails upright and clear in the middle, a strong refracted/magnified band at the rim, a single bright specular arc catching light from the upper-left, a crisp defined edge, a soft contact shadow under the ball. (Operator shared a desktop screenshot 2026-06-24; that is the bar.)

---

## The math (GLSL-ready)

The per-point bend, identical to `liquid-glass.ts::buildDisplacementMap` but computed analytically in the shader instead of baked into a texture:

```glsl
// x = 0 at the rim, 1 at the flat centre, across the curved rim band.
// (For the sphere shell, derive x from radius r: x = clamp((RIM_EDGE - r) / RIM_BAND, 0, 1).)
const float INDEX = 1.5;                 // glass refractive index
float k      = 1.0 - x;
float slope  = pow(k, 3.0) / pow(1.0 - pow(k, 4.0), 0.75);  // ∞ at rim, 0 at centre
float thetaI = atan(slope);
float thetaT = asin(sin(thetaI) / INDEX);
float bend   = sin(thetaI - thetaT);     // 0 in the centre → ~0.74 max at the rim
// aim `bend` along the outward radial normal `dir` and use it to offset the
// content sample (magnify toward centre) — strongest at the rim, nothing in the middle.
```

This is the key shape difference from a hemisphere: `bend` is **flat across the centre** and ramps up only inside `RIM_BAND`. A `sin(s)` hemisphere curves *everywhere*.

---

## Concrete changes in `refraction-ball.tsx`

The component already exposes the right dials (`u_k`, `u_fill`, `u_mag`, `u_aberr`, `u_spec`, `u_rim`). Tune toward the dome model:

1. **Geometry — flat centre, curved rim** (`MESH_VERT`, ~L57-68).
   Today `scale = sin(rho*u_k)/(rho*u_k)` curves the whole disc. Bias it so the centre stays near-flat and the curvature concentrates in the outer band — either lower `u_k` and lean on `u_mag`'s `1 - smoothstep(0,0.85,rho)` centre-swell, or replace the radial scale with the **Snell `bend` ramp above** gated to a rim band (e.g. `x` from `rho` over the outer ~25-30%). Content in the middle should sit upright and unmagnified; only the rim should bow.

2. **Chromatic — clean edge split, not a rainbow** (`SHELL_FRAG`, ~L121-128 and ~L140-142).
   The radial dispersion via `u_aberr` + `cao` (sampling R/G/B at `±dir*ab`, pinned to `pow(r,6)`) is the *correct* kind — keep it, maybe widen its reach slightly (`pow(r,4..6)`). **Tame the rainbow fringe** at L142: `cos(vec3(0,2.094,4.188)+ang*1.4 + r*20.0)` oscillates many colour cycles around the rim — real glass doesn't. Drop the `r*20.0` term (or cut it to a single cycle) so the rim shows a thin red/cyan split, not a spectrum.

3. **Specular — one crisp arc** (`SHELL_FRAG`, ~L138-139).
   The `pow(ndl,42)*u_spec` hotspot from `LIGHT = (-0.42,0.55,0.72)` is right — that's the bright upper-left catch in the reference. Keep it tight; this is the single most "glass-selling" cue.

4. **Rim/edge for a LIGHT background** (`SHELL_FRAG`, ~L141-149).
   Everything here is **additive** (`outRgb = content + glassLight`). On white, added light is invisible. Add a **subtractive** term for the edge so it reads: darken a thin contact band just inside the lip (e.g. multiply content by `1 - rimGrad*EDGE_DARK`) **before** adding the specular/edge highlight. Net effect: a defined dark-then-bright bevel — the way thick glass looks on paper. Keep the bright grazing `edge` at the very lip on top.

5. **Contact shadow** stays in the DOM wrapper (`navigator-loupe.tsx` `boxShadow`) — already present; nudge if the ball needs to feel like it's resting on the canvas.

Leave the auto-hide, drag-to-pan, and FBO plumbing alone — this is purely an optics tune.

---

## Theme: light vs dark

The canvas defaults to **light** (`rgba(244,246,249)` veil, dark ink). The rim treatment must be theme-aware:

- **Light canvas:** edge = subtle darkening **+** bright specular (see #4). Brighten-only will vanish.
- **Dark canvas:** brighten-only is fine (matches the o8-site nav, which is on a dark scene).

If the globe can appear on both tones, drive an `is-light` uniform and flip the edge sign.

---

## Guardrail: DOM glass surfaces are a different story

If anyone later wants *real refraction* (not just blur) on the **DOM** glass — the cards, docks, `glass()` panes in `ui.ts` — note:

- WebKit supports `backdrop-filter: blur() saturate()` (what `glass()` uses today — fine).
- WebKit does **not** support `backdrop-filter: url(#svgFilter)` → no refraction that way.
- WebKit **does** support CSS `filter: url(#svgFilter)` on a normal element. So real DOM refraction requires the **backdrop-copy technique**: render a counter-positioned copy of the content behind the pane, apply `feDisplacementMap` to *that copy* (via `filter:`), clip to the pane. That's exactly the Outpace approach, and the dome math above + `liquid-glass.ts` generate the displacement map. Use a `blob:` URL for the map (WebKit refuses `data:` in `feImage`) and a fresh filter `id` per rebuild (Safari caches by id).

The globe avoids all of this by being WebGL — which is why it's the right place to start.

---

## Done when

- Centre thumbnails are upright and clear; magnification/bow is concentrated at the rim (thick-glass, not fisheye).
- A single bright specular arc reads on the upper-left.
- The rim shows a thin clean chromatic split, no rotating rainbow.
- The edge is legible on the white canvas (dark contact + bright lip), and the ball casts a soft contact shadow.
- Still 60fps on drag/zoom; no regression to the auto-hide/pan behaviour.
