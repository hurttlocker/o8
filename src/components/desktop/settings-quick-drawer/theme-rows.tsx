'use client';

/**
 * Theme + surface rows for SettingsQuickDrawer — the palette (Light/Dark)
 * segmented toggle and the Glass (On/Off) surface toggle. Extracted from
 * SettingsQuickDrawer.tsx to respect the 800-line ceiling when the Glass
 * row landed (operator dogfood request 2026-07-14).
 */

import type { ReactNode } from 'react';
import type { PaletteId, SurfaceMode } from '@/lib/theme/registry';
import type { ReduceTransparency } from '@/lib/theme/context';

// Mirrors the style vocabulary in SettingsQuickDrawer.tsx — token strings only.
const FONT = 'var(--font-sans-system)';
const SUBTLE_BG = 'var(--t-bg-card, rgba(15, 23, 42, 0.04))';
const SELECTED_BG = 'var(--t-input-bg, var(--t-bg-card))';
const SELECTED_BORDER = 'var(--t-accent-border, var(--t-panel-border))';
const TEXT = 'var(--t-text, #0f172a)';
const MUTED = 'var(--t-text-muted, #64748b)';

function ThemeGlyphSun() {
  return (
    <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function ThemeGlyphMoon() {
  return (
    <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

export function ThemeContrastGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Two offset panes, the front one translucent — reads as "glass layers". */
export function GlassGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="13" height="13" rx="2.5" />
      <rect x="8" y="8" width="13" height="13" rx="2.5" fill="currentColor" fillOpacity={0.22} />
    </svg>
  );
}

function SegmentedPair({
  options,
}: {
  options: Array<{ key: string; label: string; glyph?: ReactNode; active: boolean; onPick: () => void }>;
}) {
  return (
    <div style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 8, background: SUBTLE_BG, flexShrink: 0 }}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={o.active}
          onClick={o.onPick}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            height: 20,
            paddingLeft: 7,
            paddingRight: 8,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: o.active ? SELECTED_BORDER : 'transparent',
            borderRadius: 6,
            background: o.active ? SELECTED_BG : 'transparent',
            boxShadow: o.active ? 'var(--t-panel-shadow-soft, 0 1px 2px var(--t-shadow-color, transparent))' : 'none',
            color: o.active ? TEXT : MUTED,
            fontFamily: FONT,
            fontSize: 10.5,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            cursor: 'pointer',
            transition: 'background 140ms ease, color 140ms ease',
          }}
        >
          {o.glyph}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ThemeToggle({ paletteId, setPalette }: { paletteId: PaletteId; setPalette: (id: PaletteId) => void }) {
  return (
    <SegmentedPair
      options={[
        { key: 'light', label: 'Light', glyph: <ThemeGlyphSun />, active: paletteId === 'light', onPick: () => setPalette('light') },
        { key: 'dark', label: 'Dark', glyph: <ThemeGlyphMoon />, active: paletteId === 'dark', onPick: () => setPalette('dark') },
      ]}
    />
  );
}

/**
 * Glass On/Off — flips the surface axis. Glass = reduceTransparency 'off'
 * (vibrancy chrome), Off = 'on' (opaque/solid chrome, the accessibility
 * path). Shows the EFFECTIVE surface, so a 'system' preference still reads
 * correctly; picking either side pins an explicit preference.
 */
export function SurfaceToggle({
  surface,
  setReduceTransparency,
}: {
  surface: SurfaceMode;
  setReduceTransparency: (v: ReduceTransparency) => void;
}) {
  return (
    <SegmentedPair
      options={[
        { key: 'glass', label: 'On', active: surface === 'glass', onPick: () => setReduceTransparency('off') },
        { key: 'solid', label: 'Off', active: surface === 'solid', onPick: () => setReduceTransparency('on') },
      ]}
    />
  );
}
