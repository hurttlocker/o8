'use client';

/**
 * The center stage (#1232): a pulsing
 * idle element with cycling hints, morphing into an orbiting summon
 * spinner while the fleet materialises. Owns the canvas while it is empty.
 */

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FONT } from './ui';

const IDLE_HINTS = [
  'The canvas is listening',
  'Type below — Enter builds onto the canvas',
  'Spawn from the left dock',
  'Drop an image anywhere',
  'Symon can drive this surface by voice',
];

export type Stage = { kind: 'idle' } | { kind: 'summoning'; prompt: string };

export function CenterStage({ stage }: { stage: Stage }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.06 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      style={{
        position: 'absolute',
        left: '50%',
        top: '38%',
        transform: 'translate(-50%, -50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 22,
        pointerEvents: 'none',
        zIndex: 2,
      }}
    >
      {stage.kind === 'summoning' ? <SummonRings /> : <IdlePulse />}
      {stage.kind === 'summoning' ? (
        <span style={{ fontSize: 12.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink-muted)', fontFamily: FONT }}>
          Summoning — {stage.prompt}
        </span>
      ) : (
        <CyclingHint />
      )}
    </motion.div>
  );
}

function IdlePulse() {
  return (
    <div style={{ position: 'relative', width: 84, height: 84, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <motion.span
        aria-hidden
        animate={{ scale: [1, 1.16, 1], opacity: [0.4, 0.75, 0.4] }}
        transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut' }}
        style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1px solid var(--cnv-edge)', background: 'var(--cnv-tint)' }}
      />
      <motion.span
        aria-hidden
        animate={{ scale: [1, 1.08, 1], opacity: [0.7, 1, 0.7] }}
        transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut', delay: 0.35 }}
        style={{ position: 'absolute', inset: 18, borderRadius: '50%', border: '1px solid var(--cnv-edge)' }}
      />
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--cnv-ink)' }} />
    </div>
  );
}

function SummonRings() {
  return (
    <div style={{ position: 'relative', width: 84, height: 84, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <motion.span
        aria-hidden
        animate={{ rotate: 360 }}
        transition={{ duration: 2.2, repeat: Infinity, ease: 'linear' }}
        style={{ position: 'absolute', inset: 6, borderRadius: '50%', border: '1px solid transparent', borderTopColor: 'var(--cnv-ink)', borderRightColor: 'var(--cnv-edge)' }}
      />
      <motion.span
        aria-hidden
        animate={{ rotate: -360 }}
        transition={{ duration: 3.4, repeat: Infinity, ease: 'linear' }}
        style={{ position: 'absolute', inset: 20, borderRadius: '50%', border: '1px solid transparent', borderBottomColor: 'var(--cnv-ink-muted)', borderLeftColor: 'var(--cnv-edge)' }}
      />
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--cnv-ink)' }} />
    </div>
  );
}

function CyclingHint() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((value) => (value + 1) % IDLE_HINTS.length);
    }, 4000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div style={{ height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <AnimatePresence mode="wait">
        <motion.span
          key={index}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.45, ease: 'easeOut' }}
          style={{ fontSize: 12.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink-muted)', fontFamily: FONT, whiteSpace: 'nowrap' }}
        >
          {IDLE_HINTS[index]}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}
