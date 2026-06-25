'use client';

import { useState, type CSSProperties } from 'react';
import { FooterScene, O8_DAY, GOLDEN_HOUR, DUSK, type FooterScenePalette } from './FooterScene';

const FONT = 'var(--font-sans-system)';

const PRESETS: Array<{ name: string; pal: FooterScenePalette }> = [
  { name: 'o8 day', pal: O8_DAY },
  { name: 'golden hour', pal: GOLDEN_HOUR },
  { name: 'dusk', pal: DUSK },
];

interface Tune {
  preset: number;
  height: number;
  horizon: number;
  sunX: number;
  sunY: number;
  mistDensity: number;
  mistSpeed: number;
  cloudScale: number;
  hills: boolean;
  birdRate: number;
  maxBirds: number;
}

const INITIAL: Tune = {
  preset: 0,
  height: 340,
  horizon: 0.34,
  sunX: 0.74,
  sunY: 0.42,
  mistDensity: 0.55,
  mistSpeed: 1,
  cloudScale: 1,
  hills: true,
  birdRate: 4,
  maxBirds: 2,
};

const SLIDERS: Array<{ key: keyof Tune; min: number; max: number; step: number }> = [
  { key: 'height', min: 200, max: 520, step: 10 },
  { key: 'horizon', min: 0.15, max: 0.6, step: 0.01 },
  { key: 'sunX', min: 0, max: 1, step: 0.01 },
  { key: 'sunY', min: 0, max: 1, step: 0.01 },
  { key: 'mistDensity', min: 0, max: 1, step: 0.02 },
  { key: 'mistSpeed', min: 0, max: 3, step: 0.05 },
  { key: 'cloudScale', min: 0.4, max: 2.5, step: 0.05 },
  { key: 'birdRate', min: 1, max: 12, step: 0.5 },
  { key: 'maxBirds', min: 0, max: 5, step: 1 },
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

const btn = (active: boolean): CSSProperties => ({
  paddingTop: 6,
  paddingBottom: 6,
  paddingLeft: 14,
  paddingRight: 14,
  fontSize: 12,
  fontWeight: 440,
  letterSpacing: '-0.1px',
  borderRadius: 8,
  border: active ? '1px solid #FF7A1A' : '1px solid var(--t-border, rgba(0,0,0,0.12))',
  background: active ? 'rgba(255,122,26,0.08)' : 'var(--t-bg-card, #fff)',
  color: 'var(--t-text, #111827)',
  cursor: 'pointer',
});

export default function FooterScenePreviewPage() {
  const [t, setT] = useState<Tune>(INITIAL);
  const set = <K extends keyof Tune>(k: K, v: Tune[K]) => setT((p) => ({ ...p, [k]: v }));
  const pal = PRESETS[t.preset].pal;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--t-bg, #f8f8f6)',
        color: 'var(--t-text, #111827)',
        fontFamily: FONT,
        paddingTop: 40,
        paddingBottom: 0,
      }}
    >
      <div style={{ paddingLeft: 40, paddingRight: 40 }}>
        <header style={{ maxWidth: 1100, margin: '0 auto', marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 440, letterSpacing: '-0.4px', margin: 0 }}>Footer scene lab</h1>
          <p style={{ fontSize: 13, color: 'var(--t-text-muted, #6b7280)', marginTop: 6, lineHeight: 1.5, maxWidth: 720 }}>
            Animated footer background — WebGL sky + drifting volumetric mist + parallax hills, with
            solitary birds that flap and arc across. Adjustable palette + density. Authored from scratch.
          </p>
        </header>

        <div style={{ maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Presets */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {PRESETS.map((pr, i) => (
              <button key={pr.name} type="button" onClick={() => set('preset', i)} style={btn(t.preset === i)}>
                {pr.name}
              </button>
            ))}
            <button type="button" onClick={() => set('hills', !t.hills)} style={btn(t.hills)}>
              {t.hills ? 'hills: on' : 'hills: off'}
            </button>
          </div>

          {/* Sliders */}
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

      {/* Full-bleed footer mock */}
      <div style={{ marginTop: 28, position: 'relative', width: '100%' }}>
        <FooterScene
          palette={pal}
          height={t.height}
          horizon={t.horizon}
          sunX={t.sunX}
          sunY={t.sunY}
          mistDensity={t.mistDensity}
          mistSpeed={t.mistSpeed}
          cloudScale={t.cloudScale}
          hills={t.hills}
          birdRate={t.birdRate}
          maxBirds={t.maxBirds}
        />
        {/* Footer content overlaid on the scene */}
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
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ fontSize: 34, fontWeight: 600, letterSpacing: '-1px', color: '#1c2530' }}>o8</div>
            <div style={{ display: 'flex', gap: 40 }}>
              {[
                ['Product', ['Workspace', 'Agents', 'Governance']],
                ['Company', ['About', 'Field Notes', 'Careers']],
                ['Connect', ['X', 'GitHub', 'Discord']],
              ].map(([h, items]) => (
                <div key={h as string} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 11, fontWeight: 560, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(28,37,48,0.55)' }}>{h}</div>
                  {(items as string[]).map((it) => (
                    <div key={it} style={{ fontSize: 13, fontWeight: 440, color: '#202a35' }}>{it}</div>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', fontSize: 12, color: 'rgba(28,37,48,0.6)' }}>
            <span>© 2026 o8 — the intelligent workspace.</span>
            <span>Open the intelligent workspace.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
