'use client';

import { useMemo, useState, type CSSProperties } from 'react';
import { EFFECTS, type Control, type ControlGroup, type EffectDef, type Params } from './registry';

const FONT = 'var(--font-sans-system)';
const MONO = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';
const GROUPS: ControlGroup[] = ['Simulation', 'Cursor & Solver', 'Color'];

export default function EffectsLabPage() {
  const [effectId, setEffectId] = useState(EFFECTS[0].id);
  const effect = useMemo(() => EFFECTS.find((e) => e.id === effectId) ?? EFFECTS[0], [effectId]);
  const [paramsByEffect, setParamsByEffect] = useState<Record<string, Params>>(() =>
    Object.fromEntries(EFFECTS.map((e) => [e.id, { ...e.defaults }])),
  );
  const params = paramsByEffect[effect.id];

  const setParam = (key: string, value: number | boolean | string) =>
    setParamsByEffect((prev) => ({ ...prev, [effect.id]: { ...prev[effect.id], [key]: value } }));
  const applyPreset = (values: Params) =>
    setParamsByEffect((prev) => ({ ...prev, [effect.id]: { ...values } }));

  const Effect = effect.Component;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--t-bg, #0a0a0a)',
        color: 'var(--t-text, #f4f4f5)',
        fontFamily: FONT,
        paddingTop: 32,
        paddingBottom: 96,
        paddingLeft: 24,
        paddingRight: 24,
      }}
    >
      <div style={{ maxWidth: 1120, margin: '0 auto' }}>
        <Header effect={effect} effects={EFFECTS} onSelect={setEffectId} />

        {/* Stage */}
        <div
          style={{
            position: 'relative',
            height: 480,
            borderRadius: 16,
            overflow: 'hidden',
            border: '1px solid var(--t-divider, #1d1d20)',
            background: String(params.backgroundColor ?? '#0a0a0a'),
            marginTop: 18,
          }}
        >
          <Effect key={effect.id} {...params} width="100%" height="100%" />
        </div>

        {/* Presets */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 16 }}>
          <span style={{ fontSize: 12, color: 'var(--t-text-muted, #8a8a92)', marginRight: 4 }}>Presets</span>
          {effect.presets.map((p) => (
            <button key={p.name} type="button" onClick={() => applyPreset(p.values)} style={pillStyle}>
              {p.name}
            </button>
          ))}
          <button type="button" onClick={() => applyPreset(effect.defaults)} style={{ ...pillStyle, opacity: 0.7 }}>
            Reset
          </button>
        </div>

        {/* Customize */}
        <section style={{ marginTop: 36 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <h2 style={{ fontSize: 24, fontWeight: 560, letterSpacing: '-0.5px', margin: 0 }}>Customize</h2>
            <span style={{ fontSize: 13, color: 'var(--t-text-muted, #8a8a92)' }}>Tweak the props live</span>
          </div>

          <div
            style={{
              marginTop: 16,
              borderRadius: 16,
              border: '1px solid var(--t-divider, #1d1d20)',
              background: 'var(--t-bg-card, rgba(255,255,255,0.02))',
              padding: 28,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: 40,
            }}
          >
            {GROUPS.map((group) => {
              const controls = effect.controls.filter((c) => c.group === group);
              if (controls.length === 0) return null;
              return (
                <div key={group}>
                  <h3
                    style={{
                      fontSize: 15,
                      fontWeight: 560,
                      margin: 0,
                      marginBottom: 18,
                      color: 'var(--t-text, #f4f4f5)',
                    }}
                  >
                    {group}
                  </h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                    {controls.map((c) => (
                      <ControlRow key={c.key} control={c} value={params[c.key]} onChange={setParam} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <PropsTable />
      </div>
    </div>
  );
}

function Header({
  effect,
  effects,
  onSelect,
}: {
  effect: EffectDef;
  effects: EffectDef[];
  onSelect: (id: string) => void;
}) {
  return (
    <header>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 580, letterSpacing: '-0.6px', margin: 0 }}>Effects Lab</h1>
          <p style={{ fontSize: 13, color: 'var(--t-text-muted, #8a8a92)', margin: 0, marginTop: 6, maxWidth: 640, lineHeight: 1.5 }}>
            {effect.description}
            {effect.source ? <span style={{ opacity: 0.7 }}> — {effect.source}</span> : null}
          </p>
        </div>
        {effects.length > 1 && (
          <div style={{ display: 'flex', gap: 6 }}>
            {effects.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => onSelect(e.id)}
                style={{ ...pillStyle, ...(e.id === effect.id ? activePillStyle : null) }}
              >
                {e.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </header>
  );
}

function ControlRow({
  control,
  value,
  onChange,
}: {
  control: Control;
  value: number | boolean | string;
  onChange: (key: string, value: number | boolean | string) => void;
}) {
  if (control.kind === 'slider') {
    const num = typeof value === 'number' ? value : Number(value);
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <label style={labelStyle}>{control.label}</label>
          <span style={valueChipStyle}>{formatNum(num, control.step)}</span>
        </div>
        <input
          type="range"
          min={control.min}
          max={control.max}
          step={control.step}
          value={num}
          onChange={(e) => onChange(control.key, Number(e.target.value))}
          style={rangeStyle}
        />
      </div>
    );
  }
  if (control.kind === 'toggle') {
    const on = Boolean(value);
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <label style={labelStyle}>{control.label}</label>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          onClick={() => onChange(control.key, !on)}
          style={{
            width: 42,
            height: 24,
            borderRadius: 999,
            border: '1px solid var(--t-divider, #2a2a2e)',
            background: on ? 'var(--t-text, #f4f4f5)' : 'var(--t-input-bg, rgba(255,255,255,0.06))',
            position: 'relative',
            cursor: 'pointer',
            transition: 'background 140ms ease',
            padding: 0,
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: on ? 20 : 2,
              width: 18,
              height: 18,
              borderRadius: 999,
              background: on ? 'var(--t-bg, #0a0a0a)' : 'var(--t-text-muted, #8a8a92)',
              transition: 'left 140ms ease',
            }}
          />
        </button>
      </div>
    );
  }
  // color
  const hex = String(value);
  return (
    <div>
      <label style={{ ...labelStyle, display: 'block', marginBottom: 8 }}>{control.label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ position: 'relative', width: 44, height: 44 }}>
          <input
            type="color"
            value={hex}
            onChange={(e) => onChange(control.key, e.target.value)}
            style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%', cursor: 'pointer' }}
          />
          <span
            style={{
              display: 'block',
              width: 44,
              height: 44,
              borderRadius: 999,
              background: hex,
              border: '1px solid var(--t-divider, #2a2a2e)',
            }}
          />
        </span>
        <span style={{ ...valueChipStyle, textTransform: 'uppercase' }}>{hex}</span>
      </div>
    </div>
  );
}

function PropsTable() {
  return (
    <section style={{ marginTop: 56 }}>
      <h2 style={{ fontSize: 24, fontWeight: 560, letterSpacing: '-0.5px', margin: 0, marginBottom: 16 }}>Props</h2>
      <div
        style={{
          borderRadius: 16,
          border: '1px solid var(--t-divider, #1d1d20)',
          overflow: 'hidden',
          fontSize: 13,
        }}
      >
        <div style={{ ...rowStyle, color: 'var(--t-text-muted, #8a8a92)', fontSize: 11, letterSpacing: '0.4px' }}>
          <span style={col0}>NAME</span>
          <span style={col1}>TYPE</span>
          <span style={col2}>DEFAULT</span>
          <span style={col3}>DESCRIPTION</span>
        </div>
        {PROP_ROWS.map((r, i) => (
          <div key={r.name} style={{ ...rowStyle, borderTop: i === 0 ? 'none' : '1px solid var(--t-divider, #161618)' }}>
            <span style={{ ...col0, fontFamily: MONO }}>{r.name}</span>
            <span style={{ ...col1, fontFamily: MONO, color: 'var(--t-text-muted, #8a8a92)' }}>{r.type}</span>
            <span style={{ ...col2, fontFamily: MONO }}>{r.def}</span>
            <span style={{ ...col3, color: 'var(--t-text-muted, #b4b4ba)' }}>{r.desc}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const PROP_ROWS: { name: string; type: string; def: string; desc: string }[] = [
  { name: 'width', type: 'string | number', def: '"100%"', desc: 'Container width' },
  { name: 'height', type: 'string | number', def: '"100%"', desc: 'Container height' },
  { name: 'children', type: 'ReactNode', def: 'undefined', desc: 'Content rendered above the effect' },
  { name: 'speed', type: 'number', def: '0.9', desc: 'Simulation timestep multiplier (0.1–3)' },
  { name: 'cellSize', type: 'number', def: '15', desc: 'Character cell size in pixels (6–30)' },
  { name: 'gravity', type: 'number', def: '-25', desc: 'Gravity strength (negative = downward, 0 = zero-g)' },
  { name: 'flipRatio', type: 'number', def: '0.3', desc: 'FLIP vs PIC blending ratio (0=PIC, 1=FLIP)' },
  { name: 'pressureIters', type: 'number', def: '30', desc: 'Number of pressure solver iterations (5–80)' },
  { name: 'separationIters', type: 'number', def: '3', desc: 'Number of particle separation passes (1–10)' },
  { name: 'overRelaxation', type: 'number', def: '1.5', desc: 'Over-relaxation factor for pressure solve (1–2)' },
  { name: 'fillHeight', type: 'number', def: '0.4', desc: 'Fill fraction of the tank (0–1)' },
  { name: 'cursorRadius', type: 'number', def: '0.25', desc: 'Radius of mouse influence as fraction of short side' },
  { name: 'cursorForce', type: 'number', def: '66', desc: 'Strength of cursor push force (0–200)' },
  { name: 'characters', type: 'string', def: '" ·:-~=+*#%@"', desc: 'Characters ordered by visual weight (light to heavy)' },
  { name: 'color', type: 'string', def: '"#ffffff"', desc: 'Text color (hex)' },
  { name: 'backgroundColor', type: 'string', def: '"#000000"', desc: 'Background color (hex)' },
  { name: 'fontFamily', type: 'string', def: '"monospace"', desc: 'Font family for rendering' },
  { name: 'opacity', type: 'number', def: '1', desc: 'Master opacity (0–1)' },
  { name: 'autoWave', type: 'boolean', def: 'true', desc: 'Auto-animate waves when cursor is idle' },
];

function formatNum(n: number, step: number): string {
  if (Number.isInteger(step)) return String(Math.round(n));
  const decimals = String(step).split('.')[1]?.length ?? 2;
  return n.toFixed(decimals);
}

const pillStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 480,
  paddingTop: 6,
  paddingBottom: 6,
  paddingLeft: 12,
  paddingRight: 12,
  borderRadius: 999,
  border: '1px solid var(--t-divider, #2a2a2e)',
  background: 'var(--t-input-bg, rgba(255,255,255,0.03))',
  color: 'var(--t-text, #f4f4f5)',
  cursor: 'pointer',
  fontFamily: FONT,
};

const activePillStyle: CSSProperties = {
  background: 'var(--t-text, #f4f4f5)',
  color: 'var(--t-bg, #0a0a0a)',
  borderColor: 'var(--t-text, #f4f4f5)',
};

const labelStyle: CSSProperties = { fontSize: 13.5, fontWeight: 460, color: 'var(--t-text, #e6e6e9)' };

const valueChipStyle: CSSProperties = {
  fontFamily: MONO,
  fontSize: 12,
  paddingTop: 2,
  paddingBottom: 2,
  paddingLeft: 8,
  paddingRight: 8,
  borderRadius: 6,
  background: 'var(--t-input-bg, rgba(255,255,255,0.06))',
  color: 'var(--t-text, #f4f4f5)',
  minWidth: 34,
  textAlign: 'center',
};

const rangeStyle: CSSProperties = {
  width: '100%',
  accentColor: 'var(--t-text, #f4f4f5)',
  cursor: 'pointer',
};

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.1fr 1.1fr 1fr 2.4fr',
  gap: 16,
  paddingTop: 12,
  paddingBottom: 12,
  paddingLeft: 18,
  paddingRight: 18,
  alignItems: 'center',
};

const col0: CSSProperties = { minWidth: 0 };
const col1: CSSProperties = { minWidth: 0 };
const col2: CSSProperties = { minWidth: 0 };
const col3: CSSProperties = { minWidth: 0, lineHeight: 1.45 };
