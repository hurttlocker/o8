'use client';

import { useState, type CSSProperties } from 'react';
import { FooterImage } from './FooterImage';

const FONT = 'var(--font-sans-system)';
const SRC = '/preview/footer-ridges.jpg';

interface Tune {
  height: number;
  hazeOpacity: number;
  hazeSpeed: number;
  hazeBandY: number;
  hazeBandH: number;
  hazeScale: number;
  birdRate: number;
  maxBirds: number;
  scrim: number;
}

const INITIAL: Tune = {
  height: 360,
  hazeOpacity: 0.5,
  hazeSpeed: 1,
  hazeBandY: 0.44,
  hazeBandH: 0.2,
  hazeScale: 1,
  birdRate: 5,
  maxBirds: 2,
  scrim: 0.28,
};

const SLIDERS: Array<{ key: keyof Tune; min: number; max: number; step: number }> = [
  { key: 'height', min: 220, max: 560, step: 10 },
  { key: 'hazeOpacity', min: 0, max: 1, step: 0.02 },
  { key: 'hazeSpeed', min: 0, max: 3, step: 0.05 },
  { key: 'hazeBandY', min: 0, max: 1, step: 0.01 },
  { key: 'hazeBandH', min: 0.05, max: 0.5, step: 0.01 },
  { key: 'hazeScale', min: 0.4, max: 2.5, step: 0.05 },
  { key: 'birdRate', min: 1, max: 12, step: 0.5 },
  { key: 'maxBirds', min: 0, max: 5, step: 1 },
  { key: 'scrim', min: 0, max: 0.7, step: 0.02 },
];

const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 440,
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
  color: 'var(--t-text-muted, #6b7280)',
  display: 'flex',
  justifyContent: 'space-between',
  marginBottom: 4,
};

export default function FooterImagePreviewPage() {
  const [t, setT] = useState<Tune>(INITIAL);
  const set = <K extends keyof Tune>(k: K, v: Tune[K]) => setT((p) => ({ ...p, [k]: v }));

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--t-bg, #f8f8f6)',
        color: 'var(--t-text, #111827)',
        fontFamily: FONT,
        paddingTop: 40,
      }}
    >
      <div style={{ paddingLeft: 40, paddingRight: 40 }}>
        <header style={{ maxWidth: 1100, margin: '0 auto', marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 440, letterSpacing: '-0.4px', margin: 0 }}>Footer image lab</h1>
          <p style={{ fontSize: 13, color: 'var(--t-text-muted, #6b7280)', marginTop: 6, lineHeight: 1.5, maxWidth: 720 }}>
            Your generated ridgeline photo, brought to life the reference way — static landscape +
            drifting haze + solitary birds, no video needed. Swap the &lt;img&gt; for a Veo &lt;video&gt; later.
          </p>
        </header>

        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px 24px' }}>
            {SLIDERS.map(({ key, min, max, step }) => (
              <label key={key} style={{ display: 'block' }}>
                <span style={labelStyle}>
                  <span>{key}</span>
                  <span style={{ color: 'var(--t-text, #111827)', fontVariantNumeric: 'tabular-nums' }}>
                    {Number(t[key]).toFixed(key === 'height' || key === 'maxBirds' ? 0 : 2)}
                  </span>
                </span>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={Number(t[key])}
                  onChange={(e) => set(key, Number(e.target.value) as never)}
                  style={{ width: '100%', accentColor: '#FF7A1A' }}
                />
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Full-bleed footer */}
      <div style={{ marginTop: 28, position: 'relative', width: '100%' }}>
        <FooterImage
          src={SRC}
          height={t.height}
          hazeOpacity={t.hazeOpacity}
          hazeSpeed={t.hazeSpeed}
          hazeBandY={t.hazeBandY}
          hazeBandH={t.hazeBandH}
          hazeScale={t.hazeScale}
          birdRate={t.birdRate}
          maxBirds={t.maxBirds}
        />
        {/* legibility scrim — darkens top & bottom so overlay text reads */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background: `linear-gradient(180deg, rgba(10,16,24,${t.scrim}) 0%, rgba(10,16,24,0) 26%, rgba(10,16,24,0) 64%, rgba(10,16,24,${t.scrim * 1.1}) 100%)`,
          }}
        />
        {/* Footer content */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            paddingTop: 26,
            paddingBottom: 22,
            paddingLeft: 48,
            paddingRight: 48,
            pointerEvents: 'none',
            color: '#fff',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ fontSize: 34, fontWeight: 600, letterSpacing: '-1px', color: '#fff', textShadow: '0 1px 12px rgba(0,0,0,0.35)' }}>o8</div>
            <div style={{ display: 'flex', gap: 40 }}>
              {[
                ['Product', ['Workspace', 'Agents', 'Governance']],
                ['Company', ['About', 'Field Notes', 'Careers']],
                ['Connect', ['X', 'GitHub', 'Discord']],
              ].map(([h, items]) => (
                <div key={h as string} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 11, fontWeight: 560, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.65)' }}>{h}</div>
                  {(items as string[]).map((it) => (
                    <div key={it} style={{ fontSize: 13, fontWeight: 440, color: 'rgba(255,255,255,0.92)' }}>{it}</div>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>
            <span>© 2026 o8 — the intelligent workspace.</span>
            <span>Open the intelligent workspace.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
