'use client';

import { useState, type CSSProperties } from 'react';
import { ShaderCard, type ShaderCardProps } from './ShaderCard';

const FONT = 'var(--font-sans-system)';

type Tunable = Required<Omit<ShaderCardProps, 'className' | 'style' | 'children'>>;

const INITIAL: Tunable = {
  color: '#FF9FFC',
  width: 400,
  height: 500,
  borderRadius: 16,
  speed: 1,
  positionY: 0.52,
  scale: 1,
  noiseScale: 2.6,
  branchIntensity: 0.85,
  waveAmount: 0.35,
  edgeMin: 0.15,
  edgeMax: 0.95,
  falloff: 1.6,
  boost: 1.0,
  opacity: 1,
  background: '#0a0a0d',
  autoPlay: true,
};

const SLIDERS: Array<{ key: keyof Tunable; min: number; max: number; step: number }> = [
  { key: 'speed', min: 0, max: 3, step: 0.05 },
  { key: 'positionY', min: 0, max: 1, step: 0.01 },
  { key: 'scale', min: 0.4, max: 2.5, step: 0.02 },
  { key: 'noiseScale', min: 0.5, max: 6, step: 0.05 },
  { key: 'branchIntensity', min: 0, max: 2, step: 0.02 },
  { key: 'waveAmount', min: 0, max: 1.5, step: 0.02 },
  { key: 'edgeMin', min: 0, max: 1, step: 0.01 },
  { key: 'edgeMax', min: 0, max: 1.5, step: 0.01 },
  { key: 'falloff', min: 0.5, max: 4, step: 0.05 },
  { key: 'boost', min: 0, max: 2.5, step: 0.05 },
  { key: 'opacity', min: 0, max: 1, step: 0.01 },
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

export default function ShaderCardPreviewPage() {
  const [t, setT] = useState<Tunable>(INITIAL);
  // bump to force a clean remount (re-init WebGL) after big changes
  const [seed, setSeed] = useState(0);

  const set = <K extends keyof Tunable>(k: K, v: Tunable[K]) =>
    setT((prev) => ({ ...prev, [k]: v }));

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--t-bg, #f8f8f6)',
        color: 'var(--t-text, #111827)',
        fontFamily: FONT,
        paddingTop: 40,
        paddingBottom: 80,
        paddingLeft: 40,
        paddingRight: 40,
      }}
    >
      <header style={{ maxWidth: 1100, margin: '0 auto', marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 440, letterSpacing: '-0.4px', margin: 0 }}>
          Shader Card lab
        </h1>
        <p
          style={{
            fontSize: 13,
            color: 'var(--t-text-muted, #6b7280)',
            marginTop: 6,
            lineHeight: 1.5,
            maxWidth: 720,
          }}
        >
          Animated WebGL fragment-shader card (domain-warped fBm → ridged plasma). Tune the
          params below; the values block on the right is the prop set to lock in. Authored
          from scratch — recreates the ReactBits behavior, no copied code.
        </p>
      </header>

      <div
        style={{
          maxWidth: 1100,
          margin: '0 auto',
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 440px) 1fr',
          gap: 40,
          alignItems: 'start',
        }}
      >
        {/* Live card */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'center' }}>
          <ShaderCard key={seed} {...t}>
            <div
              style={{
                position: 'absolute',
                left: 24,
                right: 24,
                bottom: 24,
                color: '#fff',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 440, opacity: 0.75, letterSpacing: '0.04em' }}>
                o8 · symon
              </div>
              <div style={{ fontSize: 26, fontWeight: 520, letterSpacing: '-0.5px', marginTop: 2 }}>
                Shader Card
              </div>
            </div>
          </ShaderCard>

          {/* Quick swatches */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            {['#FF9FFC', '#FF7A1A', '#6EA8FF', '#5EEAD4', '#C084FC', '#FFFFFF'].map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => set('color', c)}
                aria-label={`color ${c}`}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 999,
                  background: c,
                  border: t.color === c ? '2px solid #111' : '1px solid rgba(0,0,0,0.15)',
                  cursor: 'pointer',
                }}
              />
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={() => { setT(INITIAL); setSeed((s) => s + 1); }} style={btn}>
              Reset
            </button>
            <button type="button" onClick={() => setSeed((s) => s + 1)} style={btn}>
              Re-seed
            </button>
            <button type="button" onClick={() => set('autoPlay', !t.autoPlay)} style={btn}>
              {t.autoPlay ? 'Pause' : 'Play'}
            </button>
          </div>
        </div>

        {/* Controls + live prop block */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 24px' }}>
            {SLIDERS.map(({ key, min, max, step }) => (
              <label key={key} style={{ display: 'block' }}>
                <span style={labelStyle}>
                  <span>{key}</span>
                  <span style={{ color: 'var(--t-text, #111827)', fontVariantNumeric: 'tabular-nums' }}>
                    {(t[key] as number).toFixed(2)}
                  </span>
                </span>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={t[key] as number}
                  onChange={(e) => set(key, Number(e.target.value) as never)}
                  style={{ width: '100%', accentColor: '#FF7A1A' }}
                />
              </label>
            ))}
          </div>

          <pre
            style={{
              fontSize: 11.5,
              lineHeight: 1.5,
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              background: 'var(--t-bg-card, #fff)',
              border: '1px solid var(--t-border, rgba(0,0,0,0.08))',
              borderRadius: 10,
              padding: 14,
              overflowX: 'auto',
              color: 'var(--t-text, #111827)',
              margin: 0,
            }}
          >
{`<ShaderCard
  color="${t.color}"
  speed={${t.speed}}
  positionY={${t.positionY}}
  scale={${t.scale}}
  noiseScale={${t.noiseScale}}
  branchIntensity={${t.branchIntensity}}
  waveAmount={${t.waveAmount}}
  edgeMin={${t.edgeMin}}
  edgeMax={${t.edgeMax}}
  falloff={${t.falloff}}
  boost={${t.boost}}
  opacity={${t.opacity}}
/>`}
          </pre>
        </div>
      </div>
    </div>
  );
}

const btn: CSSProperties = {
  paddingTop: 6,
  paddingBottom: 6,
  paddingLeft: 14,
  paddingRight: 14,
  fontSize: 12,
  fontWeight: 440,
  letterSpacing: '-0.1px',
  borderRadius: 8,
  border: '1px solid var(--t-border, rgba(0,0,0,0.12))',
  background: 'var(--t-bg-card, #fff)',
  color: 'var(--t-text, #111827)',
  cursor: 'pointer',
};
