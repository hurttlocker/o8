'use client';

/**
 * Canvas depth layers (#1232) — professional see-through backdrops painted
 * over the veil, under everything else. The Anthropic/Apple move: texture
 * so quiet you only notice it when it's gone. Selected in the Canvas
 * tuner (settings.backdrop); every layer is pointer-transparent and reads
 * THROUGH the glass cards above it (their backdrop blur diffuses it).
 *
 *   paper  — warm paper grain + soft top light, the Anthropic paper feel
 *   mesh   — still duotone mesh gradient, Apple keynote-slide depth
 *   aurora — slow drifting colour fields, the living version
 *   grain  — pure monochrome film grain, quietest of the four
 */

import { motion } from 'framer-motion';

// feTurbulence noise tile as a data URI — no asset, no network.
const NOISE_TILE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;

export function CanvasBackdropLayer({ kind }: { kind: string }) {
  if (kind === 'paper') {
    return (
      <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1 }}>
        {/* Grain — the paper tooth. */}
        <div style={{ position: 'absolute', inset: 0, backgroundImage: NOISE_TILE, opacity: 0.05, mixBlendMode: 'overlay' as const }} />
        {/* Warm top light + settled bottom — the page under a desk lamp. */}
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(120% 85% at 50% 0%, rgba(252, 248, 240, 0.075) 0%, rgba(252, 248, 240, 0.02) 38%, transparent 62%)' }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, transparent 55%, rgba(4, 5, 8, 0.22) 100%)' }} />
      </div>
    );
  }

  if (kind === 'mesh') {
    return (
      <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1, overflow: 'hidden' }}>
        {[
          { x: '14%', y: '18%', size: 720, color: 'rgba(86, 116, 255, 0.13)', duration: 26 },
          { x: '78%', y: '30%', size: 640, color: 'rgba(255, 158, 92, 0.07)', duration: 32 },
          { x: '50%', y: '88%', size: 820, color: 'rgba(132, 90, 255, 0.09)', duration: 38 },
        ].map((blob, index) => (
          <motion.div
            key={index}
            animate={{ scale: [1, 1.07, 1], opacity: [1, 0.82, 1] }}
            transition={{ duration: blob.duration, repeat: Infinity, ease: 'easeInOut' }}
            style={{
              position: 'absolute',
              left: blob.x,
              top: blob.y,
              width: blob.size,
              height: blob.size,
              marginLeft: -blob.size / 2,
              marginTop: -blob.size / 2,
              borderRadius: '50%',
              background: `radial-gradient(circle, ${blob.color} 0%, transparent 68%)`,
              filter: 'blur(60px)',
            }}
          />
        ))}
      </div>
    );
  }

  if (kind === 'aurora') {
    return (
      <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1, overflow: 'hidden' }}>
        {[
          { size: 640, color: 'rgba(64, 106, 255, 0.14)', from: { x: '-8%', y: '12%' }, to: { x: '18%', y: '30%' }, duration: 52 },
          { size: 720, color: 'rgba(255, 132, 64, 0.08)', from: { x: '70%', y: '60%' }, to: { x: '52%', y: '42%' }, duration: 64 },
          { size: 560, color: 'rgba(168, 92, 255, 0.10)', from: { x: '40%', y: '-14%' }, to: { x: '58%', y: '6%' }, duration: 58 },
          { size: 600, color: 'rgba(34, 197, 94, 0.06)', from: { x: '8%', y: '74%' }, to: { x: '26%', y: '56%' }, duration: 72 },
        ].map((blob, index) => (
          <motion.div
            key={index}
            animate={{ left: [blob.from.x, blob.to.x, blob.from.x], top: [blob.from.y, blob.to.y, blob.from.y] }}
            transition={{ duration: blob.duration, repeat: Infinity, ease: 'easeInOut' }}
            style={{
              position: 'absolute',
              width: blob.size,
              height: blob.size,
              borderRadius: '50%',
              background: `radial-gradient(circle, ${blob.color} 0%, transparent 70%)`,
              filter: 'blur(52px)',
            }}
          />
        ))}
      </div>
    );
  }

  if (kind === 'grain') {
    return (
      <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1 }}>
        <div style={{ position: 'absolute', inset: 0, backgroundImage: NOISE_TILE, opacity: 0.045, mixBlendMode: 'soft-light' as const }} />
        <div style={{ position: 'absolute', inset: 0, backgroundImage: NOISE_TILE, backgroundPosition: '110px 84px', opacity: 0.03, mixBlendMode: 'overlay' as const }} />
      </div>
    );
  }

  return null;
}
