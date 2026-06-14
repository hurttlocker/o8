'use client';

/**
 * OrbTuner (#1239) — the live slider panel for the NavigatorLoupe crystal
 * ball's refraction. Each dial drives a shader uniform in real time, so the
 * operator tunes the glass on screen (no code edits / reloads) and the values
 * persist per canvas tone. Opens above the navigator from its IconButton.
 * Mirrors the canvas Glass tuner; reuses its TunerSlider.
 */

import type { CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { FONT, glass } from './ui';
import { GlassSlider } from './glass-slider';
import { ORB_DIALS, ORB_RANGES, type CanvasTone, type OrbSettings } from './orb-settings';

const SECTION_LABEL: CSSProperties = {
  fontSize: 9.5,
  fontWeight: 300,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--cnv-ink-muted)',
  fontFamily: FONT,
};

function fmt(value: number, step: number): string {
  return value.toFixed(step < 0.01 ? 3 : 2);
}

export function OrbTuner({
  settings,
  onChange,
  onReset,
  tone,
}: {
  settings: OrbSettings;
  onChange: (patch: Partial<OrbSettings>) => void;
  onReset: () => void;
  tone: CanvasTone;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      style={{
        position: 'absolute',
        left: 0,
        bottom: 'calc(100% + 10px)',
        width: 212,
        display: 'flex',
        flexDirection: 'column',
        gap: 9,
        paddingTop: 12,
        paddingRight: 12,
        paddingBottom: 12,
        paddingLeft: 12,
        borderRadius: 14,
        zIndex: 60,
        ...glass(true),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={SECTION_LABEL}>Orb refraction</span>
        <span style={{ ...SECTION_LABEL, letterSpacing: '0.04em' }}>{tone}</span>
      </div>
      {ORB_DIALS.map((dial) => (
        <GlassSlider
          key={dial.key}
          label={dial.label}
          display={fmt(settings[dial.key], ORB_RANGES[dial.key].step)}
          value={settings[dial.key]}
          range={ORB_RANGES[dial.key]}
          onChange={(value) => onChange({ [dial.key]: value } as Partial<OrbSettings>)}
        />
      ))}
      <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 2 }}>
        <button
          type="button"
          onClick={onReset}
          style={{ borderWidth: 0, background: 'transparent', padding: 0, fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', cursor: 'pointer', fontFamily: FONT }}
          onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
        >
          Reset
        </button>
      </div>
    </motion.div>
  );
}
