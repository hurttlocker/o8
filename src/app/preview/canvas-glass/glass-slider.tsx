'use client';

/**
 * GlassSlider — a reusable glassmorphism slider for canvas tuners. Native
 * <input type=range> can't be glass-styled without ::pseudo CSS (and this app
 * is inline-styles-only), so this is a div-based track + a frosted glass bead
 * thumb, drag + keyboard driven. Theme-aware: the groove and the thumb outline
 * use --cnv tokens so the bead stays visible in both light and dark (the amber
 * fill is the canvas accent). Drop-in for the orb tuner's dials.
 */

import { useRef } from 'react';
import { FONT } from './ui';

const THUMB = 14;

export function GlassSlider({
  label,
  display,
  value,
  range,
  onChange,
}: {
  label: string;
  display: string;
  value: number;
  range: { min: number; max: number; step: number };
  onChange: (value: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const { min, max, step } = range;
  const pct = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;

  const snap = (raw: number) => {
    const stepped = Math.round(raw / step) * step;
    const clamped = Math.min(max, Math.max(min, stepped));
    return Number(clamped.toFixed(6));
  };

  const setFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const t = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
    onChange(snap(min + t * (max - min)));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--cnv-ink)', fontFamily: FONT }}>{label}</span>
        <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontVariantNumeric: 'tabular-nums', fontFamily: FONT }}>{display}</span>
      </div>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        onPointerDown={(event) => {
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
          dragging.current = true;
          setFromClientX(event.clientX);
        }}
        onPointerMove={(event) => { if (dragging.current) setFromClientX(event.clientX); }}
        onPointerUp={(event) => { dragging.current = false; try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* */ } }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); onChange(snap(value - step)); }
          else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); onChange(snap(value + step)); }
        }}
        style={{ position: 'relative', height: 18, display: 'flex', alignItems: 'center', cursor: 'pointer', touchAction: 'none' }}
      >
        {/* Frosted groove. */}
        <div style={{ position: 'absolute', left: 0, right: 0, height: 5, borderRadius: 999, background: 'var(--cnv-edge)', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.28)' }} />
        {/* Filled value — the canvas amber accent, glowing glass. */}
        <div style={{ position: 'absolute', left: 0, width: `calc(${THUMB / 2}px + (100% - ${THUMB}px) * ${pct})`, height: 5, borderRadius: 999, background: 'linear-gradient(90deg, rgba(245,158,11,0.5), rgba(245,158,11,0.92))', boxShadow: '0 0 7px rgba(245,158,11,0.32)' }} />
        {/* Glass bead thumb — translucent fill + ink outline (visible both tones). */}
        <div
          style={{
            position: 'absolute',
            left: `calc((100% - ${THUMB}px) * ${pct})`,
            width: THUMB,
            height: THUMB,
            borderRadius: 999,
            background: 'var(--cnv-tint)',
            border: '1px solid var(--cnv-ink)',
            boxShadow: '0 2px 5px rgba(0,0,0,0.4), inset 0 1px 1px rgba(255,255,255,0.45)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
          }}
        />
      </div>
    </div>
  );
}
