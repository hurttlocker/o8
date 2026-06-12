'use client';

/**
 * The floating glass tuner — presets, background material + veil, and the
 * pane sliders (#1232). Mirrors the Settings → Operator Defaults tuner.
 */

import { useState } from 'react';
import {
  CANVAS_GLASS_DEFAULTS,
  CANVAS_GLASS_MATERIALS,
  CANVAS_GLASS_PRESETS,
  CANVAS_GLASS_RANGES,
  type CanvasGlassSettings,
} from '@/lib/canvas-mode/glass-settings';
import { FONT, glass } from './ui';

export function TunerPanel({
  settings,
  onChange,
  inTauri,
  right = 16,
}: {
  settings: CanvasGlassSettings;
  onChange: (patch: Partial<CanvasGlassSettings>) => void;
  inTauri: boolean;
  /** Shifts left when the orchestrator dock is open. */
  right?: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div
      style={{
        position: 'absolute',
        top: 18,
        right,
        width: collapsed ? undefined : 224,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        paddingTop: 10,
        paddingRight: 12,
        paddingBottom: 12,
        paddingLeft: 12,
        borderRadius: 14,
        zIndex: 8,
        ...glass(true),
      }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          borderWidth: 0,
          background: 'transparent',
          padding: 0,
          color: 'var(--cnv-ink)',
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          cursor: 'pointer',
          fontFamily: FONT,
        }}
      >
        Glass tuner
        <span style={{ fontSize: 10, fontWeight: 300, color: 'var(--cnv-ink-muted)' }}>{collapsed ? 'show' : 'hide'}</span>
      </button>
      {collapsed ? null : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {CANVAS_GLASS_PRESETS.map((preset) => {
              const active = settings.frost === preset.values.frost
                && settings.tint === preset.values.tint
                && settings.ink === preset.values.ink
                && settings.veil === preset.values.veil
                && settings.material === preset.values.material
                && settings.backdropFrost === preset.values.backdropFrost;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => onChange({ ...preset.values })}
                  style={{
                    flex: 1,
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: active ? 'var(--cnv-ink-muted)' : 'var(--cnv-edge)',
                    background: active ? 'rgba(255,255,255,0.1)' : 'transparent',
                    borderRadius: 999,
                    paddingTop: 3,
                    paddingBottom: 3,
                    fontSize: 10.5,
                    fontWeight: active ? 500 : 300,
                    color: active ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
                    cursor: 'pointer',
                    fontFamily: FONT,
                  }}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
          <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT }}>
            Background
          </span>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
            {CANVAS_GLASS_MATERIALS.map((material) => {
              const active = settings.material === material.id;
              return (
                <button
                  key={material.id}
                  type="button"
                  onClick={() => onChange({ material: material.id })}
                  title={material.label}
                  style={{
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: active ? 'var(--cnv-ink-muted)' : 'var(--cnv-edge)',
                    background: active ? 'rgba(255,255,255,0.1)' : 'transparent',
                    borderRadius: 7,
                    paddingTop: 4,
                    paddingBottom: 4,
                    paddingLeft: 2,
                    paddingRight: 2,
                    fontSize: 9,
                    fontWeight: active ? 500 : 300,
                    color: active ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
                    cursor: 'pointer',
                    fontFamily: FONT,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {material.label}
                </button>
              );
            })}
          </div>
          <TunerSlider label="Backdrop frost" display={`${Math.round(settings.backdropFrost)}px`} value={settings.backdropFrost} range={CANVAS_GLASS_RANGES.backdropFrost} onChange={(backdropFrost) => onChange({ backdropFrost })} />
          <TunerSlider label="Veil" display={`${Math.round(settings.veil * 100)}%`} value={settings.veil} range={CANVAS_GLASS_RANGES.veil} onChange={(veil) => onChange({ veil })} />
          <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT }}>
            Glass panes
          </span>
          <TunerSlider label="Frost" display={`${Math.round(settings.frost)}px`} value={settings.frost} range={CANVAS_GLASS_RANGES.frost} onChange={(frost) => onChange({ frost })} />
          <TunerSlider label="Tint" display={`${Math.round(settings.tint * 100)}%`} value={settings.tint} range={CANVAS_GLASS_RANGES.tint} onChange={(tint) => onChange({ tint })} />
          <TunerSlider label="Ink" display={`${Math.round(settings.ink * 100)}%`} value={settings.ink} range={CANVAS_GLASS_RANGES.ink} onChange={(ink) => onChange({ ink })} />
          <TunerSlider label="Vibrance" display={`${Math.round(settings.vibrance * 100)}%`} value={settings.vibrance} range={CANVAS_GLASS_RANGES.vibrance} onChange={(vibrance) => onChange({ vibrance })} />
          <button
            type="button"
            onClick={() => onChange({ ...CANVAS_GLASS_DEFAULTS })}
            style={{
              alignSelf: 'flex-start',
              borderWidth: 0,
              background: 'transparent',
              padding: 0,
              fontSize: 10.5,
              fontWeight: 300,
              color: 'var(--cnv-ink-muted)',
              cursor: 'pointer',
              fontFamily: FONT,
            }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            Reset defaults
          </button>
          {inTauri ? null : (
            <span style={{ fontSize: 9.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', lineHeight: 1.5, fontFamily: FONT }}>
              Open in the o8 app to see your desktop through the glass.
            </span>
          )}
        </>
      )}
    </div>
  );
}

function TunerSlider({
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
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--cnv-ink)', fontFamily: FONT }}>{label}</span>
        <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontVariantNumeric: 'tabular-nums', fontFamily: FONT }}>{display}</span>
      </div>
      <input
        type="range"
        aria-label={`Canvas glass ${label.toLowerCase()}`}
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        onChange={(event) => {
          const next = Number.parseFloat(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        style={{ width: '100%', accentColor: '#f59e0b', cursor: 'pointer' }}
      />
    </div>
  );
}
