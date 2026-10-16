'use client';

import { useId } from 'react';

// Owned voice identity, shared with the live HUD. This existing brand palette
// is the documented exception to themeable surface colors; chrome uses tokens.
export const SYMON_ORB_BACKGROUND = 'radial-gradient(circle at 64% 28%, color-mix(in srgb, var(--t-text) 90%, transparent), transparent 30%), conic-gradient(from 210deg at 50% 50%, #88d1f1, #b1b4e5 32%, #f5b8c4 62%, #f4c977 82%, #88d1f1)';
export const SYMON_GRADIENT_STOPS: Array<[number, string]> = [
  [0, 'rgba(136, 209, 241, 0.92)'],
  [0.42, 'rgba(177, 180, 229, 0.95)'],
  [0.72, 'rgba(245, 184, 196, 0.92)'],
  [1, 'rgba(244, 201, 119, 0.92)'],
];
const BAR_COUNT = 30;
export const SYMON_WAVEFORM = {
  barCount: BAR_COUNT, barWidth: 2, barGap: 2.5, width: 132.5, height: 24,
  weights: Array.from({ length: BAR_COUNT }, (_, i) => {
    const center = (BAR_COUNT - 1) / 2;
    return Math.exp(-1.8 * (Math.abs(i - center) / center) ** 2);
  }),
};
export const SYMON_POLISH_PATH = 'M8 28C32 22 48 14 72 14C96 14 108 34 132 34C156 34 170 12 198 12C230 12 238 38 272 38C304 38 316 18 344 18C372 18 388 28 408 28';

export function SymonMark({ size = 17, active = false }: { size?: number; active?: boolean }) {
  return <span aria-hidden="true" style={{ display: 'inline-block', flexShrink: 0, width: size, height: size, borderRadius: '50%', background: SYMON_ORB_BACKGROUND, boxShadow: active ? '0 0 0 2px var(--t-accent), 0 0 9px rgba(136, 209, 241, 0.45)' : '0 0 9px rgba(136, 209, 241, 0.45)' }} />;
}

/** Static preview, or measured input. No ambient activity or recording claim. */
export function SymonWaveform({ level = 0, width = SYMON_WAVEFORM.width }: { level?: number; width?: number }) {
  const gradient = useId();
  const wave = SYMON_WAVEFORM;
  return <svg aria-hidden="true" width={width} height={wave.height} viewBox={`0 0 ${wave.width} ${wave.height}`} style={{ display: 'block', flexShrink: 0 }}>
    <defs><linearGradient id={gradient}>{SYMON_GRADIENT_STOPS.map(([offset, color]) => <stop key={offset} offset={offset} stopColor={color} />)}</linearGradient></defs>
    {wave.weights.map((weight, i) => {
      const height = Math.max(2, Math.min(1, Math.max(0, level)) * weight * wave.height);
      return <rect key={i} x={i * (wave.barWidth + wave.barGap)} y={(wave.height - height) / 2} width={wave.barWidth} height={height} rx={1} fill={`url(#${gradient})`} />;
    })}
  </svg>;
}

/** The live HUD's polishing silhouette, at rest for a labeled feature preview. */
export function SymonPolishMark() {
  const gradient = useId();
  return <svg aria-hidden="true" width={42} height={18} viewBox="0 0 416 52" style={{ display: 'block', flexShrink: 0 }}>
    <defs><linearGradient id={gradient}>{SYMON_GRADIENT_STOPS.map(([offset, color]) => <stop key={offset} offset={offset} stopColor={color} />)}</linearGradient></defs>
    <path d={SYMON_POLISH_PATH} fill="none" stroke={`url(#${gradient})`} strokeWidth={12} strokeLinecap="round" />
  </svg>;
}
