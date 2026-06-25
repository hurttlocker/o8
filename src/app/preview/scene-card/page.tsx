'use client';

import { useState, type CSSProperties } from 'react';
import { SceneCard } from './SceneCard';

const FONT = 'var(--font-sans-system)';

interface Tune {
  horizon: number;
  sunX: number;
  sunY: number;
  fog: number;
  density: number;
  speed: number;
  scale: number;
  grassHeight: number;
  scrim: number;
}

const INITIAL: Tune = {
  horizon: 0.52,
  sunX: 0.72,
  sunY: 0.58,
  fog: 1,
  density: 0.5,
  speed: 1,
  scale: 1.15,
  grassHeight: 0.14,
  scrim: 0.42,
};

const SLIDERS: Array<{ key: keyof Tune; min: number; max: number; step: number }> = [
  { key: 'horizon', min: 0.3, max: 0.75, step: 0.01 },
  { key: 'sunX', min: 0, max: 1, step: 0.01 },
  { key: 'sunY', min: 0.3, max: 0.85, step: 0.01 },
  { key: 'fog', min: 0, max: 1.5, step: 0.02 },
  { key: 'density', min: 0, max: 1, step: 0.02 },
  { key: 'speed', min: 0, max: 3, step: 0.05 },
  { key: 'scale', min: 0.6, max: 2.5, step: 0.05 },
  { key: 'grassHeight', min: 0, max: 0.35, step: 0.01 },
  { key: 'scrim', min: 0, max: 0.8, step: 0.02 },
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

const ink = '#fff';
const shadow = '0 1px 14px rgba(40,24,8,0.4)';

function PricingCard(t: Tune) {
  return (
    <SceneCard {...t} width={360} height={470}>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 26, color: ink }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 560, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.8)', textShadow: shadow }}>Founding Operator</div>
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'baseline', gap: 6, textShadow: shadow }}>
            <span style={{ fontSize: 46, fontWeight: 600, letterSpacing: '-1.5px' }}>$150</span>
            <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.8)' }}>/ once</span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, fontSize: 13.5, fontWeight: 440, textShadow: shadow }}>
          {['Full governed fleet — no extra sub', 'Priority on the build-in-public roadmap', 'Founding Operator status & voice', 'Lifetime — never a locked door'].map((f) => (
            <div key={f} style={{ display: 'flex', gap: 9, alignItems: 'center', color: 'rgba(255,255,255,0.94)' }}>
              <span style={{ width: 16, height: 16, borderRadius: 999, background: 'rgba(255,255,255,0.22)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, flexShrink: 0 }}>✓</span>
              {f}
            </div>
          ))}
        </div>
        <button
          type="button"
          style={{
            width: '100%', paddingTop: 13, paddingBottom: 13, borderRadius: 12, border: '1px solid rgba(255,255,255,0.5)',
            background: 'rgba(255,255,255,0.92)', color: '#2a1c0c', fontSize: 14.5, fontWeight: 560, letterSpacing: '-0.2px', cursor: 'pointer',
            backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
          }}
        >
          Become a Founding Operator
        </button>
      </div>
    </SceneCard>
  );
}

function FeatureCard(t: Tune) {
  return (
    <SceneCard {...t} width={360} height={300} grassHeight={t.grassHeight + 0.02}>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: 24, color: ink }}>
        <div style={{ fontSize: 12, fontWeight: 560, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.8)', textShadow: shadow }}>Organizational memory</div>
        <div style={{ fontSize: 24, fontWeight: 560, letterSpacing: '-0.6px', marginTop: 4, textShadow: shadow }}>The workspace remembers.</div>
        <div style={{ fontSize: 13.5, fontWeight: 440, color: 'rgba(255,255,255,0.86)', marginTop: 6, lineHeight: 1.5, textShadow: shadow }}>
          Every decision, directive, and outcome — recalled across the fleet.
        </div>
      </div>
    </SceneCard>
  );
}

function ModalMock(t: Tune) {
  return (
    <div style={{ position: 'relative', width: 360, height: 470, borderRadius: 18, overflow: 'hidden', background: '#1a1f27', boxShadow: '0 20px 50px -20px rgba(0,0,0,0.6)' }}>
      {/* dimmed page behind */}
      <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(180deg, rgba(255,255,255,0.05) 0 14px, transparent 14px 28px)' }} />
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(8,10,14,0.55)' }} />
      {/* the modal itself = a scene card */}
      <div style={{ position: 'absolute', left: 28, right: 28, top: 70, display: 'flex', justifyContent: 'center' }}>
        <SceneCard {...t} width={304} height={330} borderRadius={16}>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 22, color: ink }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.5px', textShadow: shadow }}>Open the workspace</div>
              <div style={{ fontSize: 13, fontWeight: 440, color: 'rgba(255,255,255,0.85)', marginTop: 6, lineHeight: 1.5, textShadow: shadow }}>
                Plan, code, and operate in one system-wide IDE.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" style={{ flex: 1, paddingTop: 10, paddingBottom: 10, borderRadius: 10, border: '1px solid rgba(255,255,255,0.35)', background: 'rgba(255,255,255,0.12)', color: '#fff', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Later</button>
              <button type="button" style={{ flex: 1, paddingTop: 10, paddingBottom: 10, borderRadius: 10, border: '1px solid rgba(255,255,255,0.5)', background: 'rgba(255,255,255,0.92)', color: '#2a1c0c', fontSize: 13, fontWeight: 560, cursor: 'pointer' }}>Get started</button>
            </div>
          </div>
        </SceneCard>
      </div>
    </div>
  );
}

export default function SceneCardPreviewPage() {
  const [t, setT] = useState<Tune>(INITIAL);
  const set = <K extends keyof Tune>(k: K, v: Tune[K]) => setT((p) => ({ ...p, [k]: v }));

  return (
    <div style={{ minHeight: '100vh', background: 'var(--t-bg, #f5f5f3)', color: 'var(--t-text, #111827)', fontFamily: FONT, paddingTop: 40, paddingBottom: 80, paddingLeft: 40, paddingRight: 40 }}>
      <header style={{ maxWidth: 1180, margin: '0 auto', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 440, letterSpacing: '-0.4px', margin: 0 }}>Scene card lab</h1>
        <p style={{ fontSize: 13, color: 'var(--t-text-muted, #6b7280)', marginTop: 6, lineHeight: 1.5, maxWidth: 720 }}>
          The sunrise-landscape look as a <strong>card / pricing / modal</strong> background — drifting valley fog,
          a glowing sun disc, layered hazy ridges, lit grass. Content sits over a warm scrim. Authored from scratch.
        </p>
      </header>

      <div style={{ maxWidth: 1180, margin: '0 auto', marginBottom: 30 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px 24px' }}>
          {SLIDERS.map(({ key, min, max, step }) => (
            <label key={key} style={{ display: 'block' }}>
              <span style={labelStyle}>
                <span>{key}</span>
                <span style={{ color: 'var(--t-text, #111827)', fontVariantNumeric: 'tabular-nums' }}>{Number(t[key]).toFixed(2)}</span>
              </span>
              <input type="range" min={min} max={max} step={step} value={Number(t[key])} onChange={(e) => set(key, Number(e.target.value) as never)} style={{ width: '100%', accentColor: '#FF7A1A' }} />
            </label>
          ))}
        </div>
      </div>

      <div style={{ maxWidth: 1180, margin: '0 auto', display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {PricingCard(t)}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {FeatureCard(t)}
          <div style={{ fontSize: 11, color: 'var(--t-text-muted, #6b7280)', textAlign: 'center' }}>feature card · pricing card · modal</div>
        </div>
        <div>{ModalMock(t)}</div>
      </div>
    </div>
  );
}
