'use client';

/**
 * CanvasGlassTuner — frost / tint / ink sliders for the Canvas-mode glass
 * material (#1232). Renders under the Experimental: Canvas toggle when the
 * flag is on. Values live-apply as CSS vars (see lib/canvas-mode/
 * glass-settings) and persist client-side; the /preview/canvas-glass test
 * page reads the same vars, so tuning here re-skins it live.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  CANVAS_GLASS_DEFAULTS,
  CANVAS_GLASS_MATERIALS,
  CANVAS_GLASS_PRESETS,
  CANVAS_GLASS_RANGES,
  applyCanvasGlassSettings,
  readCanvasGlassSettings,
  writeCanvasGlassSettings,
  type CanvasGlassSettings,
} from '@/lib/canvas-mode/glass-settings';

export function CanvasGlassTuner() {
  const [settings, setSettings] = useState<CanvasGlassSettings>(CANVAS_GLASS_DEFAULTS);

  useEffect(() => {
    const stored = readCanvasGlassSettings();
    setSettings(stored);
    applyCanvasGlassSettings(stored);
  }, []);

  const update = useCallback((patch: Partial<CanvasGlassSettings>) => {
    setSettings((previous) => {
      const next = { ...previous, ...patch };
      writeCanvasGlassSettings(next);
      return next;
    });
  }, []);

  return (
    <div
      style={{
        marginTop: 4,
        marginBottom: 12,
        paddingTop: 12,
        paddingRight: 14,
        paddingBottom: 12,
        paddingLeft: 14,
        borderRadius: 10,
        border: '1px solid var(--t-divider)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--t-text)' }}>
          Glass material
        </span>
        <span style={{ fontSize: 11, color: 'var(--t-text-muted)', fontWeight: 300 }}>
          Preview at <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10.5 }}>/preview/canvas-glass</span>
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
              onClick={() => update({ ...preset.values })}
              style={{
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: active ? 'var(--t-accent)' : 'var(--t-divider)',
                background: active ? 'var(--t-bg-hover)' : 'transparent',
                borderRadius: 999,
                paddingTop: 3,
                paddingRight: 12,
                paddingBottom: 3,
                paddingLeft: 12,
                fontSize: 11,
                fontWeight: active ? 500 : 300,
                color: active ? 'var(--t-text)' : 'var(--t-text-secondary)',
                cursor: 'pointer',
                fontFamily: 'var(--font-sans-system)',
              }}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 10.5, fontWeight: 400, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t-text-muted)' }}>
          Background material
        </span>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 4 }}>
          {CANVAS_GLASS_MATERIALS.map((material) => {
            const active = settings.material === material.id;
            return (
              <button
                key={material.id}
                type="button"
                onClick={() => update({ material: material.id })}
                title={material.label}
                style={{
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: active ? 'var(--t-accent)' : 'var(--t-divider)',
                  background: active ? 'var(--t-bg-hover)' : 'transparent',
                  borderRadius: 7,
                  paddingTop: 4,
                  paddingBottom: 4,
                  paddingLeft: 2,
                  paddingRight: 2,
                  fontSize: 10,
                  fontWeight: active ? 500 : 300,
                  color: active ? 'var(--t-text)' : 'var(--t-text-secondary)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-sans-system)',
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
        <span style={{ fontSize: 10.5, color: 'var(--t-text-faint)', fontWeight: 300, lineHeight: 1.4 }}>
          The native macOS layer the whole canvas runs on — your desktop reads through it. Applies when a canvas surface opens.
        </span>
      </div>
      <GlassSlider
        label="Backdrop frost"
        hint="Desktop blur behind the window — the Liquid-mode frost dial, works on every material"
        value={settings.backdropFrost}
        display={`${Math.round(settings.backdropFrost)}px`}
        min={CANVAS_GLASS_RANGES.backdropFrost.min}
        max={CANVAS_GLASS_RANGES.backdropFrost.max}
        step={CANVAS_GLASS_RANGES.backdropFrost.step}
        onChange={(backdropFrost) => update({ backdropFrost })}
      />
      <GlassSlider
        label="Veil"
        hint="Window-wide dark wash over the background — darkness of the world itself"
        value={settings.veil}
        display={`${Math.round(settings.veil * 100)}%`}
        min={CANVAS_GLASS_RANGES.veil.min}
        max={CANVAS_GLASS_RANGES.veil.max}
        step={CANVAS_GLASS_RANGES.veil.step}
        onChange={(veil) => update({ veil })}
      />
      <GlassSlider
        label="Frost"
        hint="Backdrop blur — how much the world behind a pane diffuses"
        value={settings.frost}
        display={`${Math.round(settings.frost)}px`}
        min={CANVAS_GLASS_RANGES.frost.min}
        max={CANVAS_GLASS_RANGES.frost.max}
        step={CANVAS_GLASS_RANGES.frost.step}
        onChange={(frost) => update({ frost })}
      />
      <GlassSlider
        label="Tint"
        hint="Dark glass density — 0 is clear, high is the Siri material"
        value={settings.tint}
        display={`${Math.round(settings.tint * 100)}%`}
        min={CANVAS_GLASS_RANGES.tint.min}
        max={CANVAS_GLASS_RANGES.tint.max}
        step={CANVAS_GLASS_RANGES.tint.step}
        onChange={(tint) => update({ tint })}
      />
      <GlassSlider
        label="Ink"
        hint="Text + icon brightness against the glass"
        value={settings.ink}
        display={`${Math.round(settings.ink * 100)}%`}
        min={CANVAS_GLASS_RANGES.ink.min}
        max={CANVAS_GLASS_RANGES.ink.max}
        step={CANVAS_GLASS_RANGES.ink.step}
        onChange={(ink) => update({ ink })}
      />
      <GlassSlider
        label="Vibrance"
        hint="How colourful the bleed-through reads inside the panes"
        value={settings.vibrance}
        display={`${Math.round(settings.vibrance * 100)}%`}
        min={CANVAS_GLASS_RANGES.vibrance.min}
        max={CANVAS_GLASS_RANGES.vibrance.max}
        step={CANVAS_GLASS_RANGES.vibrance.step}
        onChange={(vibrance) => update({ vibrance })}
      />
      <div>
        <button
          type="button"
          onClick={() => update({ ...CANVAS_GLASS_DEFAULTS })}
          style={{
            borderWidth: 0,
            background: 'transparent',
            padding: 0,
            fontSize: 11,
            fontWeight: 300,
            color: 'var(--t-text-muted)',
            cursor: 'pointer',
            fontFamily: 'var(--font-sans-system)',
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--t-text)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--t-text-muted)'; }}
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

function GlassSlider({
  label,
  hint,
  value,
  display,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--t-text)' }}>{label}</span>
        <span style={{ fontSize: 11, color: 'var(--t-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{display}</span>
      </div>
      <input
        type="range"
        aria-label={`Canvas glass ${label.toLowerCase()}`}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          const next = Number.parseFloat(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        style={{
          width: '100%',
          accentColor: 'var(--t-accent)',
          cursor: 'pointer',
        }}
      />
      <span style={{ fontSize: 10.5, color: 'var(--t-text-faint)', fontWeight: 300, lineHeight: 1.4 }}>{hint}</span>
    </div>
  );
}
