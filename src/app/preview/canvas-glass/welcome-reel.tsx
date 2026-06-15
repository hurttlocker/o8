'use client';

/**
 * O8Reel — the right-pane scene of the welcome modal. A calm "Paper Aurora"
 * ground (soft gradient + slow color washes + dot grid) with the tagline
 * rising in, plus the hero subtle motion: soft light MOTES that
 * drift slowly ACROSS the pane behind the text — our control-plane read on the
 * reference's "element crossing behind the glass" (a butterfly, there). The
 * capability walkthrough now lives in the guided tour, so this stays calm and
 * branded, not a feature reel.
 *
 * framer-motion (Remotion's Player won't run in the embedded WebKit). Tone-aware,
 * reduced-motion safe. V1 — tune mote count/speed/hues here.
 */

import { motion, useReducedMotion } from 'framer-motion';
import { FONT } from './ui';

export function O8Reel({ tone }: { tone: 'light' | 'dark' }) {
  const reduce = useReducedMotion();
  const isDark = tone === 'dark';

  const ink = isDark ? '#f4f5f7' : '#16181d';
  const dot = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)';
  const bg = isDark ? 'linear-gradient(155deg,#202430 0%,#14171f 100%)' : 'linear-gradient(155deg,#f8f8f6 0%,#ececea 100%)';

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: bg, fontFamily: FONT }}>
      {/* aurora ground — slow washes, the ambient bed the motes drift over */}
      <Aurora hue="rgba(255,122,60,0.42)" base={{ top: '30%', left: '36%' }} drift={{ x: 24, y: 18 }} duration={15} dim={isDark ? 0.5 : 0.4} reduce={!!reduce} />
      <Aurora hue="rgba(132,120,255,0.4)" base={{ top: '66%', left: '70%' }} drift={{ x: 28, y: 22 }} duration={18} dim={isDark ? 0.5 : 0.4} reduce={!!reduce} />
      <Aurora hue="rgba(86,214,170,0.36)" base={{ top: '74%', left: '26%' }} drift={{ x: 22, y: 20 }} duration={21} dim={isDark ? 0.45 : 0.36} reduce={!!reduce} />

      {/* drifting motes — the hero subtle motion: soft lights crossing the pane,
          at different sizes/speeds for depth. They pass BEHIND the text. */}
      <Mote color={isDark ? 'rgba(255,206,166,0.95)' : 'rgba(255,150,90,0.9)'} size={11} yBase={150} duration={17} reduce={!!reduce} />
      <Mote color={isDark ? 'rgba(196,204,255,0.9)' : 'rgba(140,150,255,0.7)'} size={7} yBase={210} duration={23} reduce={!!reduce} />
      <Mote color={isDark ? 'rgba(255,255,255,0.75)' : 'rgba(110,200,170,0.7)'} size={5} yBase={96} duration={29} reduce={!!reduce} />

      {/* dot grid — the canvas signature */}
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

      {/* tagline — "comes up and says it", then rests. Matches the left
          pane's headline: weight 300, -0.02em tracking, 1.12 line-height. */}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 40, paddingRight: 40 }}>
        <motion.div
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
          style={{ textAlign: 'center', fontSize: 31, fontWeight: 300, lineHeight: 1.12, letterSpacing: '-0.02em', color: ink, maxWidth: 340 }}
        >
          The control plane for your agents.
        </motion.div>
      </div>
    </div>
  );
}

/** A soft light drifting slowly across the pane (enters left, exits right, with
 *  a gentle vertical bob + scale breath). Different durations desync the set. */
function Mote({ color, size, yBase, duration, reduce }: { color: string; size: number; yBase: number; duration: number; reduce: boolean }) {
  if (reduce) {
    return (
      <div
        aria-hidden
        style={{
          position: 'absolute',
          left: '50%',
          top: yBase,
          width: size,
          height: size,
          borderRadius: '50%',
          background: color,
          filter: `blur(${Math.max(1, size * 0.3)}px)`,
          boxShadow: `0 0 ${size * 3}px ${size}px ${color}`,
          opacity: 0.5,
          pointerEvents: 'none',
        }}
      />
    );
  }
  return (
    <motion.div
      aria-hidden
      initial={false}
      animate={{
        x: [-60, 480],
        y: [yBase - 14, yBase + 10, yBase - 6, yBase + 14, yBase - 10],
        opacity: [0, 0.95, 0.95, 0.95, 0],
        scale: [0.8, 1.1, 0.95, 1.08, 0.82],
      }}
      transition={{ duration, repeat: Infinity, ease: 'easeInOut', times: [0, 0.2, 0.5, 0.8, 1] }}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        filter: `blur(${Math.max(1, size * 0.3)}px)`,
        boxShadow: `0 0 ${size * 3}px ${size * 1.2}px ${color}`,
        pointerEvents: 'none',
      }}
    />
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
