'use client';

/**
 * Canvas depth layers (#1232) — Paper Shaders (shaders.paper.design),
 * the real thing: WebGL gradients/noise with VERY subtle motion, painted
 * over the veil, under everything else. Each mood runs near-black, slow
 * (speed ≤ 0.1), and semi-transparent — WebGL paints opaque pixels, so
 * the wrapper opacity is what keeps the desktop/material reading through.
 *
 *   paper  — warm grain gradient, the lamplit-page feel
 *   mesh   — cool slate mesh, Apple-keynote depth, barely breathing
 *   aurora — deep blue/violet fields drifting at the edge of perception
 *   grain  — neuro-noise web, the quietest texture of the four
 *
 * Perf: minPixelRatio 1 (skip Retina oversampling) + maxPixelCount cap —
 * the two knobs that matter for a full-window layer. Pauses when the
 * document is hidden (built into the library).
 */

import { useEffect, useState } from 'react';
import { GrainGradient, MeshGradient, NeuroNoise } from '@paper-design/shaders-react';

const FILL = { position: 'absolute' as const, inset: 0, width: '100%', height: '100%' };
const PERF = { minPixelRatio: 1, maxPixelCount: 1280 * 720, fit: 'cover' as const };

export function CanvasBackdropLayer({ kind }: { kind: string }) {
  // WebGL2 probe — the library throws without it. One-time, cheap.
  const [webgl, setWebgl] = useState(false);
  useEffect(() => {
    try {
      setWebgl(Boolean(document.createElement('canvas').getContext('webgl2')));
    } catch {
      setWebgl(false);
    }
  }, []);

  if (!webgl || kind === 'none') return null;

  return (
    <div aria-hidden style={{ ...FILL, pointerEvents: 'none', zIndex: 1, overflow: 'hidden' }}>
      {kind === 'paper' ? (
        <div style={{ ...FILL, opacity: 0.5 }}>
          <GrainGradient
            colors={['#171310', '#100d0a', '#1c1712']}
            colorBack="#0a0806"
            shape="wave"
            softness={0.9}
            intensity={0.18}
            noise={0.32}
            speed={0.05}
            scale={1.3}
            {...PERF}
            style={FILL}
          />
        </div>
      ) : null}
      {kind === 'mesh' ? (
        <div style={{ ...FILL, opacity: 0.55 }}>
          <MeshGradient
            colors={['#0a0e13', '#0e141c', '#0c1a24', '#090c11']}
            distortion={0.35}
            swirl={0.15}
            grainOverlay={0.12}
            speed={0.07}
            scale={1.4}
            {...PERF}
            style={FILL}
          />
        </div>
      ) : null}
      {kind === 'aurora' ? (
        <div style={{ ...FILL, opacity: 0.5 }}>
          <MeshGradient
            colors={['#070b12', '#0a1626', '#121034', '#07181d']}
            distortion={0.5}
            swirl={0.3}
            grainOverlay={0.08}
            speed={0.1}
            scale={1.15}
            {...PERF}
            style={FILL}
          />
        </div>
      ) : null}
      {kind === 'grain' ? (
        <div style={{ ...FILL, opacity: 0.32 }}>
          <NeuroNoise
            colorFront="#2a3340"
            colorMid="#10151c"
            colorBack="#07090d"
            brightness={0.18}
            contrast={0.28}
            speed={0.05}
            scale={0.7}
            {...PERF}
            style={FILL}
          />
        </div>
      ) : null}
    </div>
  );
}
