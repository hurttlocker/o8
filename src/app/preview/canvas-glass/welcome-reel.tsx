'use client';

/**
 * O8Reel — the looping "video" in the welcome modal's right pane: it opens on
 * the tagline, then cycles through what o8 does, over a slow drifting aurora.
 *
 * Originally a Remotion composition, but Remotion's <Player> would not advance
 * frames inside the embedded Tauri WebKit (came up paused, isPlaying never
 * flipped). framer-motion's RAF loop runs fine here (it drives the rest of the
 * canvas), so the reel is driven by it: a beat index on an interval + an
 * AnimatePresence crossfade, with the aurora on infinite motion loops. Same
 * visual design, reliably playing. Tone-aware; reduced-motion safe.
 *
 * (A true baked-video path still exists: render this script with @remotion/
 * renderer to an mp4 per tone and swap a <video> in. Deferred — the live reel
 * themes for free and needs no asset.)
 */

import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { FONT } from './ui';

type GlyphName = 'plane' | 'chat' | 'fleet' | 'diff' | 'check';

const BEATS: Array<{ text: string; glyph: GlyphName; hero?: boolean }> = [
  { text: 'The control plane for your agents.', glyph: 'plane', hero: true },
  { text: 'Talk to the orchestrator.', glyph: 'chat' },
  { text: 'Agents build in parallel.', glyph: 'fleet' },
  { text: 'Review every diff.', glyph: 'diff' },
  { text: 'Ship on your approval.', glyph: 'check' },
];

/** The hero line holds a beat longer than the capability lines. */
const HERO_MS = 3400;
const BEAT_MS = 2500;
const ACCENT = '#FF5A1F';

export function O8Reel({ tone }: { tone: 'light' | 'dark' }) {
  const reduce = useReducedMotion();
  const isDark = tone === 'dark';
  const [i, setI] = useState(0);

  // Advance the beat. Each beat schedules the next (hero holds longer).
  useEffect(() => {
    const id = window.setTimeout(() => setI((prev) => (prev + 1) % BEATS.length), BEATS[i].hero ? HERO_MS : BEAT_MS);
    return () => window.clearTimeout(id);
  }, [i]);

  const ink = isDark ? '#f4f5f7' : '#16181d';
  const muted = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(15,23,42,0.5)';
  const dot = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(15,23,42,0.07)';
  const bg = isDark ? 'linear-gradient(155deg,#202430 0%,#14171f 100%)' : 'linear-gradient(155deg,#f8f8f6 0%,#ececea 100%)';

  const beat = BEATS[i];

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: bg, fontFamily: FONT }}>
      {/* aurora — slow drifting washes; reads on both tones, off under reduced-motion */}
      <Aurora hue="rgba(255,122,60,0.5)" base={{ top: '30%', left: '38%' }} drift={{ x: 28, y: 20 }} duration={13} dim={isDark ? 0.6 : 0.5} reduce={!!reduce} />
      <Aurora hue="rgba(132,120,255,0.46)" base={{ top: '66%', left: '70%' }} drift={{ x: 32, y: 24 }} duration={16} dim={isDark ? 0.6 : 0.5} reduce={!!reduce} />
      <Aurora hue="rgba(86,214,170,0.42)" base={{ top: '74%', left: '28%' }} drift={{ x: 26, y: 22 }} duration={19} dim={isDark ? 0.55 : 0.45} reduce={!!reduce} />

      {/* dotted grid — the canvas signature */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `radial-gradient(circle, ${dot} 1px, transparent 1px)`,
          backgroundSize: '20px 20px',
          maskImage: 'radial-gradient(130% 120% at 70% 30%, #000 30%, transparent 82%)',
          WebkitMaskImage: 'radial-gradient(130% 120% at 70% 30%, #000 30%, transparent 82%)',
        }}
      />

      {/* persistent o8 wordmark */}
      <div style={{ position: 'absolute', top: 22, left: 26, fontSize: 22, fontWeight: 500, letterSpacing: '0.01em', color: ink }}>o8</div>

      {/* the beats — one crossfades out as the next slides up */}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 36, paddingRight: 36 }}>
        <AnimatePresence mode="wait">
          <motion.div
            key={i}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 18 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -14 }}
            transition={{ duration: 0.46, ease: [0.22, 1, 0.36, 1] }}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, textAlign: 'center' }}
          >
            <span style={{ display: 'inline-flex', color: ACCENT }}>
              <Glyph name={beat.glyph} size={beat.hero ? 38 : 30} />
            </span>
            <span style={{ fontSize: beat.hero ? 32 : 27, fontWeight: 500, lineHeight: 1.18, letterSpacing: '-0.03em', color: ink, maxWidth: 320 }}>
              {beat.text}
            </span>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* progress dots */}
      <div style={{ position: 'absolute', bottom: 26, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 6 }}>
        {BEATS.map((_, n) => (
          <div
            key={n}
            style={{
              width: n === i ? 22 : 6,
              height: 6,
              borderRadius: 999,
              background: n === i ? ACCENT : muted,
              opacity: n === i ? 1 : 0.4,
              transition: 'width 240ms ease, background 240ms ease, opacity 240ms ease',
            }}
          />
        ))}
      </div>
    </div>
  );
}

function Aurora({
  hue,
  base,
  drift,
  duration,
  dim,
  reduce,
}: {
  hue: string;
  base: { top: string; left: string };
  drift: { x: number; y: number };
  duration: number;
  dim: number;
  reduce: boolean;
}) {
  const size = 300;
  return (
    <motion.div
      aria-hidden
      animate={reduce ? undefined : { x: [-drift.x, drift.x], y: [drift.y, -drift.y], scale: [1, 1.12, 1] }}
      transition={reduce ? undefined : { duration, repeat: Infinity, repeatType: 'mirror', ease: 'easeInOut' }}
      style={{
        position: 'absolute',
        top: base.top,
        left: base.left,
        width: size,
        height: size,
        marginLeft: -size / 2,
        marginTop: -size / 2,
        borderRadius: '50%',
        background: `radial-gradient(circle, ${hue} 0%, transparent 70%)`,
        filter: 'blur(50px)',
        opacity: dim,
        pointerEvents: 'none',
      }}
    />
  );
}

// ── glyphs ───────────────────────────────────────────────────────────────
function Glyph({ name, size }: { name: GlyphName; size: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2 as const,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (name === 'chat') {
    return (
      <svg {...common}>
        <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
      </svg>
    );
  }
  if (name === 'fleet') {
    return (
      <svg {...common}>
        <circle cx="12" cy="6" r="2" />
        <circle cx="6" cy="18" r="2" />
        <circle cx="18" cy="18" r="2" />
        <path d="M12 8v4" />
        <path d="m12 12-6 4" />
        <path d="m12 12 6 4" />
      </svg>
    );
  }
  if (name === 'diff') {
    return (
      <svg {...common}>
        <path d="M12 3v6" />
        <path d="M9 6h6" />
        <path d="M12 15v6" />
        <path d="M9 18h6" />
        <path d="M4 12h16" />
      </svg>
    );
  }
  if (name === 'check') {
    return (
      <svg {...common}>
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="5" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <path d="M12 7v3" />
      <path d="M12 10 6 17" />
      <path d="m12 10 6 7" />
      <path d="M7 19h10" />
    </svg>
  );
}
