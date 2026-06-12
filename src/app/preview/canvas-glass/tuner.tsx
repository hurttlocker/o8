'use client';

/**
 * The glass tuner — opens UNDER the "Canvas" word in the top dock (#1232).
 * Presets (including the operator's saved "Mine" look), background material
 * + backdrop frost + veil, and the pane sliders. Mirrors the Settings →
 * Operator Defaults tuner; "Save as my default" snapshots the current look.
 */

import { motion } from 'framer-motion';
import {
  CANVAS_BACKDROPS,
  CANVAS_CHAT_TONES,
  CANVAS_GLASS_DEFAULTS,
  CANVAS_GLASS_MATERIALS,
  CANVAS_GLASS_PRESETS,
  CANVAS_GLASS_RANGES,
  CANVAS_GLASS_TONES,
  type CanvasGlassSettings,
} from '@/lib/canvas-mode/glass-settings';
import { FONT, glass } from './ui';

function settingsMatch(a: CanvasGlassSettings, b: CanvasGlassSettings): boolean {
  return a.frost === b.frost
    && a.tint === b.tint
    && a.ink === b.ink
    && a.veil === b.veil
    && a.vibrance === b.vibrance
    && a.material === b.material
    && a.backdropFrost === b.backdropFrost
    && a.backdrop === b.backdrop
    && a.chatFrost === b.chatFrost
    && a.chatTint === b.chatTint
    && a.tone === b.tone
    && a.chatTone === b.chatTone;
}

export function TunerPanel({
  settings,
  onChange,
  inTauri,
  personalDefault,
  onSaveDefault,
}: {
  settings: CanvasGlassSettings;
  onChange: (patch: Partial<CanvasGlassSettings>) => void;
  inTauri: boolean;
  personalDefault: CanvasGlassSettings | null;
  onSaveDefault: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      style={{
        position: 'absolute',
        top: 66,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 236,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        paddingTop: 12,
        paddingRight: 12,
        paddingBottom: 12,
        paddingLeft: 12,
        borderRadius: 14,
        zIndex: 44,
        ...glass(true),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5 }}>
        {personalDefault ? (
          <PresetPill
            label="Mine"
            active={settingsMatch(settings, personalDefault)}
            onClick={() => onChange({ ...personalDefault })}
          />
        ) : null}
        {CANVAS_GLASS_PRESETS.map((preset) => (
          <PresetPill
            key={preset.id}
            label={preset.label}
            active={settingsMatch(settings, preset.values)}
            onClick={() => onChange({ ...preset.values })}
          />
        ))}
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
        Depth
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: 4 }}>
        {CANVAS_BACKDROPS.map((backdrop) => {
          const active = settings.backdrop === backdrop.id;
          return (
            <button
              key={backdrop.id}
              type="button"
              onClick={() => onChange({ backdrop: backdrop.id })}
              title={backdrop.label}
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
                fontSize: 8.5,
                fontWeight: active ? 500 : 300,
                color: active ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
                cursor: 'pointer',
                fontFamily: FONT,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {backdrop.label}
            </button>
          );
        })}
      </div>
      <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT }}>
        Glass panes
      </span>
      <div style={{ display: 'flex', gap: 5 }}>
        {CANVAS_GLASS_TONES.map((tone) => (
          <PresetPill
            key={tone.id}
            label={tone.label}
            active={settings.tone === tone.id}
            onClick={() => onChange({ tone: tone.id })}
          />
        ))}
      </div>
      <TunerSlider label="Frost" display={`${Math.round(settings.frost)}px`} value={settings.frost} range={CANVAS_GLASS_RANGES.frost} onChange={(frost) => onChange({ frost })} />
      <TunerSlider label="Tint" display={`${Math.round(settings.tint * 100)}%`} value={settings.tint} range={CANVAS_GLASS_RANGES.tint} onChange={(tint) => onChange({ tint })} />
      <TunerSlider label="Ink" display={`${Math.round(settings.ink * 100)}%`} value={settings.ink} range={CANVAS_GLASS_RANGES.ink} onChange={(ink) => onChange({ ink })} />
      <TunerSlider label="Vibrance" display={`${Math.round(settings.vibrance * 100)}%`} value={settings.vibrance} range={CANVAS_GLASS_RANGES.vibrance} onChange={(vibrance) => onChange({ vibrance })} />
      <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT }}>
        Floating chats
      </span>
      <div style={{ display: 'flex', gap: 5 }}>
        {CANVAS_CHAT_TONES.map((tone) => (
          <PresetPill
            key={tone.id}
            label={tone.label}
            active={settings.chatTone === tone.id}
            onClick={() => onChange({ chatTone: tone.id })}
          />
        ))}
      </div>
      <TunerSlider label="Frost" display={`${Math.round(settings.chatFrost)}px`} value={settings.chatFrost} range={CANVAS_GLASS_RANGES.chatFrost} onChange={(chatFrost) => onChange({ chatFrost })} />
      <TunerSlider label="Tint" display={`${Math.round(settings.chatTint * 100)}%`} value={settings.chatTint} range={CANVAS_GLASS_RANGES.chatTint} onChange={(chatTint) => onChange({ chatTint })} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <button
          type="button"
          onClick={onSaveDefault}
          style={{
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--cnv-edge)',
            background: 'transparent',
            borderRadius: 999,
            paddingTop: 4,
            paddingBottom: 4,
            paddingLeft: 12,
            paddingRight: 12,
            fontSize: 10.5,
            fontWeight: 400,
            color: 'var(--cnv-ink)',
            cursor: 'pointer',
            fontFamily: FONT,
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.1)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
        >
          Save as my default
        </button>
        <button
          type="button"
          onClick={() => onChange({ ...CANVAS_GLASS_DEFAULTS })}
          style={{
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
          Reset
        </button>
      </div>
      {inTauri ? null : (
        <span style={{ fontSize: 9.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', lineHeight: 1.5, fontFamily: FONT }}>
          Open in the o8 app to see your desktop through the glass.
        </span>
      )}
    </motion.div>
  );
}

function PresetPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: active ? 'var(--cnv-ink-muted)' : 'var(--cnv-edge)',
        background: active ? 'rgba(255,255,255,0.1)' : 'transparent',
        borderRadius: 999,
        paddingTop: 3,
        paddingBottom: 3,
        paddingLeft: 11,
        paddingRight: 11,
        fontSize: 10.5,
        fontWeight: active ? 500 : 300,
        color: active ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
        cursor: 'pointer',
        fontFamily: FONT,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
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
