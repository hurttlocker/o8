'use client';

/**
 * The Canvas theme panel — opens under the "Canvas" word in the top dock
 * (#1232). ONE unified Appearance (Dark/Light) drives the background, panes,
 * dock, chats, and modals together; a curated row of Looks; the few global
 * dials (Text · Glass · Background · Blur · Depth); and an Advanced drawer for
 * per-surface tuning. Mirrors Settings → Operator Defaults; "Save as my
 * default" snapshots the current look.
 */

import { useState, type CSSProperties } from 'react';
import { motion } from 'framer-motion';
import {
  CANVAS_BACKDROPS,
  CANVAS_CHAT_TONES,
  CANVAS_DOCK_TONES,
  CANVAS_GLASS_DEFAULTS,
  CANVAS_GLASS_MATERIALS,
  CANVAS_GLASS_PRESETS,
  CANVAS_GLASS_RANGES,
  CANVAS_GLASS_TONES,
  canvasFreeLook,
  canvasFreeLookIdFor,
  CANVAS_FREE_LOOKS,
  defaultTextShadeForTone,
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
    && a.chatTone === b.chatTone
    && a.dockTone === b.dockTone
    && a.dockTint === b.dockTint
    && a.textShade === b.textShade;
}

/** The Text slider's zone label — operator reads words, not decimals. */
function textShadeLabel(shade: number): string {
  if (shade <= 0.12) return 'White';
  if (shade >= 0.88) return 'Black';
  return 'Ink';
}

const SECTION_LABEL: CSSProperties = {
  fontSize: 9.5,
  fontWeight: 300,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--cnv-ink-muted)',
  fontFamily: FONT,
};

export function TunerPanel({
  settings,
  onChange,
  inTauri,
  personalDefault,
  loupeSize,
  loupeSizeRange,
  onLoupeSizeChange,
  onSaveDefault,
  full = true,
}: {
  settings: CanvasGlassSettings;
  onChange: (patch: Partial<CanvasGlassSettings>) => void;
  inTauri: boolean;
  personalDefault: CanvasGlassSettings | null;
  loupeSize: number;
  loupeSizeRange: { min: number; max: number; step: number };
  onLoupeSizeChange: (value: number) => void;
  onSaveDefault: () => void;
  /** Founders get the whole panel; free gets Paper in light/dark only (the
   *  look where text reads right) — no other looks, dials, depth, or advanced. */
  full?: boolean;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

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
        maxHeight: 'min(78vh, 680px)',
        overflowY: 'auto',
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
      {/* Appearance — the master. One switch flips the whole canvas: the
          background, every pane, the dock, chats, and the modals, plus the
          text seed. Light is a true white canvas, not light panes on dark. */}
      <span style={SECTION_LABEL}>Appearance</span>
      <div style={{ display: 'flex', gap: 5 }}>
        {full ? CANVAS_GLASS_TONES.map((tone) => (
          <PresetPill
            key={tone.id}
            label={tone.label}
            grow
            active={settings.tone === tone.id}
            onClick={() => onChange({
              tone: tone.id,
              textShade: defaultTextShadeForTone(tone.id),
              veil: tone.id === 'light' ? 1 : 0.3,
            })}
          />
        )) : CANVAS_FREE_LOOKS.map((look) => (
          // Free tier (Q 2026-07-17): three fixed looks — Dark / Light /
          // Glass (the locked ALL GLASS recipe) — applied wholesale.
          <PresetPill
            key={look.id}
            label={look.label}
            grow
            active={canvasFreeLookIdFor(settings) === look.id}
            onClick={() => onChange({ ...canvasFreeLook(look.id) })}
          />
        ))}
      </div>

      {!full ? (
        <span style={{ fontSize: 9.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', lineHeight: 1.5, fontFamily: FONT }}>
          Looks, depth, and the dials unlock with a founding license.
        </span>
      ) : null}

      {full ? (<>
      {/* Looks — curated full-combo presets, plus the operator's saved Custom. */}
      <span style={SECTION_LABEL}>Looks</span>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5 }}>
        {personalDefault ? (
          <PresetPill
            label="Custom"
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

      {/* The four unified dials — each drives every surface at once. */}
      <TunerSlider
        label="Text"
        display={`${textShadeLabel(settings.textShade)} · ${Math.round(settings.textShade * 100)}`}
        value={settings.textShade}
        range={CANVAS_GLASS_RANGES.textShade}
        onChange={(textShade) => onChange({ textShade })}
      />
      <TunerSlider label="Glass" display={`${Math.round(settings.tint * 100)}%`} value={settings.tint} range={CANVAS_GLASS_RANGES.tint} onChange={(tint) => onChange({ tint })} />
      <TunerSlider label="Background" display={`${Math.round(settings.veil * 100)}%`} value={settings.veil} range={CANVAS_GLASS_RANGES.veil} onChange={(veil) => onChange({ veil })} />
      <TunerSlider label="Blur" display={`${Math.round(settings.frost)}px`} value={settings.frost} range={CANVAS_GLASS_RANGES.frost} onChange={(frost) => onChange({ frost })} />
      <TunerSlider label="Loupe size" display={`${Math.round(loupeSize)}px`} value={loupeSize} range={loupeSizeRange} onChange={onLoupeSizeChange} />

      {/* Depth — the mood layer painted behind the glass. */}
      <span style={SECTION_LABEL}>Depth</span>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 4 }}>
        {CANVAS_BACKDROPS.map((backdrop) => (
          <Chip
            key={backdrop.id}
            label={backdrop.label}
            active={settings.backdrop === backdrop.id}
            onClick={() => onChange({ backdrop: backdrop.id })}
          />
        ))}
      </div>

      {/* Advanced — per-surface power tuning, collapsed so the panel stays calm. */}
      <button
        type="button"
        onClick={() => setAdvancedOpen((value) => !value)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, borderWidth: 0, background: 'transparent', paddingTop: 2, paddingBottom: 2, paddingLeft: 0, paddingRight: 0, cursor: 'pointer', fontFamily: FONT }}
      >
        <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink-muted)" strokeWidth={3} aria-hidden style={{ transform: advancedOpen ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}>
          <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={SECTION_LABEL}>Advanced</span>
      </button>
      {advancedOpen ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={SECTION_LABEL}>Material</span>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
            {CANVAS_GLASS_MATERIALS.map((material) => (
              <Chip
                key={material.id}
                label={material.label}
                active={settings.material === material.id}
                onClick={() => onChange({ material: material.id })}
              />
            ))}
          </div>
          <TunerSlider label="Desktop blur" display={`${Math.round(settings.backdropFrost)}px`} value={settings.backdropFrost} range={CANVAS_GLASS_RANGES.backdropFrost} onChange={(backdropFrost) => onChange({ backdropFrost })} />
          <TunerSlider label="Vibrance" display={`${Math.round(settings.vibrance * 100)}%`} value={settings.vibrance} range={CANVAS_GLASS_RANGES.vibrance} onChange={(vibrance) => onChange({ vibrance })} />
          <TunerSlider label="Text opacity" display={`${Math.round(settings.ink * 100)}%`} value={settings.ink} range={CANVAS_GLASS_RANGES.ink} onChange={(ink) => onChange({ ink })} />

          <span style={SECTION_LABEL}>Cards</span>
          <div style={{ display: 'flex', gap: 5 }}>
            {CANVAS_CHAT_TONES.map((tone) => (
              <PresetPill key={tone.id} label={tone.label} active={settings.chatTone === tone.id} onClick={() => onChange({ chatTone: tone.id })} />
            ))}
          </div>
          <TunerSlider label="Frost" display={`${Math.round(settings.chatFrost)}px`} value={settings.chatFrost} range={CANVAS_GLASS_RANGES.chatFrost} onChange={(chatFrost) => onChange({ chatFrost })} />
          <TunerSlider label="Tint" display={`${Math.round(settings.chatTint * 100)}%`} value={settings.chatTint} range={CANVAS_GLASS_RANGES.chatTint} onChange={(chatTint) => onChange({ chatTint })} />

          <span style={SECTION_LABEL}>Dock</span>
          <div style={{ display: 'flex', gap: 5 }}>
            {CANVAS_DOCK_TONES.map((tone) => (
              <PresetPill key={tone.id} label={tone.label} active={settings.dockTone === tone.id} onClick={() => onChange({ dockTone: tone.id })} />
            ))}
          </div>
          <TunerSlider label="Tint" display={`${Math.round(settings.dockTint * 100)}%`} value={settings.dockTint} range={CANVAS_GLASS_RANGES.dockTint} onChange={(dockTint) => onChange({ dockTint })} />
        </div>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingTop: 2 }}>
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
          Save as Custom
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
      </>) : null}
      {inTauri ? null : (
        <span style={{ fontSize: 9.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', lineHeight: 1.5, fontFamily: FONT }}>
          Open in the o8 app to see your desktop through the glass.
        </span>
      )}
    </motion.div>
  );
}

function PresetPill({ label, active, onClick, grow }: { label: string; active: boolean; onClick: () => void; grow?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: grow ? 1 : undefined,
        textAlign: grow ? 'center' : undefined,
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

/** A compact grid chip — material + depth pickers. */
function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
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
