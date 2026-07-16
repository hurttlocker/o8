'use client';

/**
 * Appearance row for SettingsQuickDrawer — ONE merged control for the theme
 * system's two axes (Q ruling 2026-07-16, replacing the separate Theme and
 * Glass rows): the labeled Light/Dark segments carry the palette DECISION,
 * and an icon-only latch at the pill's right end carries the glass MODIFIER.
 * One row instead of two; every palette × surface state stays one click.
 * Extracted from SettingsQuickDrawer.tsx for the 800-line ceiling.
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

/** Two offset panes, the front one translucent — reads as "glass layers".
 *  Heavier than the default icon weight ON PURPOSE (hurttlocker lens,
 *  operator live-hit 2026-07-16): at 13-15px, 2px strokes render ~1.2px and
 *  a 0.22 fill vanishes on both palettes — the latch read as empty space. */
export function GlassGlyph({ size = 13 }: { size?: number }) {
  return (
    // Width/height as INLINE STYLE, not just attributes: a drawer-scoped
    // stylesheet rule computed this svg to width:0 inside the latch's flex
    // button (live-hit 2026-07-16 — the glyph vanished while its ink was
    // fine). Inline sizing wins over any sheet.
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinejoin="round" aria-hidden="true" style={{ width: size, height: size, flexShrink: 0, display: 'block' }}>
      <rect x="3" y="3" width="13" height="13" rx="2.5" />
      <rect x="8" y="8" width="13" height="13" rx="2.5" fill="currentColor" fillOpacity={0.5} />
    </svg>
  );
}

/**
 * AppearanceControl — the merged palette + surface pill. Left/labeled half is
 * the Light/Dark segmented pair; a hairline divider separates the icon-only
 * glass latch on the right. The latch shows the EFFECTIVE surface (a 'system'
 * preference still reads correctly) and picking it pins an explicit
 * preference: glass = reduceTransparency 'off' (vibrancy chrome), off =
 * 'on' (opaque/solid chrome, the accessibility path). Palette flips never
 * touch the latch state — the two axes stay independent.
 */
export function AppearanceControl({
  paletteId,
  setPalette,
  surface,
  setReduceTransparency,
}: {
  paletteId: PaletteId;
  setPalette: (id: PaletteId) => void;
  surface: SurfaceMode;
  setReduceTransparency: (v: ReduceTransparency) => void;
}) {
  const glassOn = surface === 'glass';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: 2, borderRadius: 8, background: SUBTLE_BG, flexShrink: 0 }}>
      <SegmentButton
        active={paletteId === 'light'}
        onPick={() => setPalette('light')}
        label="Light"
        glyph={<ThemeGlyphSun />}
      />
      <SegmentButton
        active={paletteId === 'dark'}
        onPick={() => setPalette('dark')}
        label="Dark"
        glyph={<ThemeGlyphMoon />}
      />
      <span aria-hidden style={{ width: 1, height: 12, background: 'var(--t-divider-subtle)', marginLeft: 1, marginRight: 1, flexShrink: 0 }} />
      <button
        type="button"
        aria-pressed={glassOn}
        aria-label={glassOn ? 'Glass surface on' : 'Glass surface off'}
        title={glassOn ? 'Glass surface — on' : 'Glass surface — off'}
        onClick={() => setReduceTransparency(glassOn ? 'on' : 'off')}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 20,
          borderWidth: 1,
          borderStyle: 'solid',
          // Off state keeps a faint FRAME (not transparent like inactive
          // segments): an icon-only control with no label and no resting
          // treatment reads as empty pill space — the operator couldn't
          // find it (live-hit 2026-07-16).
          borderColor: glassOn ? SELECTED_BORDER : 'var(--t-divider, rgba(127,127,127,0.25))',
          borderRadius: 6,
          background: glassOn ? SELECTED_BG : 'transparent',
          boxShadow: glassOn ? 'var(--t-panel-shadow-soft, 0 1px 2px var(--t-shadow-color, transparent))' : 'none',
          // Icon-only latch needs MORE ink than the labeled segments — a
          // muted 13px stroke glyph disappears on paper (hurttlocker lens:
          // tune for the eye, not the token). Secondary ink + 14px when off.
          color: glassOn ? TEXT : 'var(--t-text-secondary, #475569)',
          cursor: 'pointer',
          transition: 'background 140ms ease, color 140ms ease',
        }}
      >
        <GlassGlyph size={14} />
      </button>
    </div>
  );
}

function SegmentButton({ active, onPick, label, glyph }: { active: boolean; onPick: () => void; label: string; glyph?: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onPick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        // Tighter than the drawer's other pills ON PURPOSE: this row's
        // min-content must stay under the drawer body's ~264px or the grid
        // track grows and every row overflows the panel (live-hit
        // 2026-07-16 — trailing values ended 1px from the edge).
        gap: 3,
        height: 20,
        paddingLeft: 5,
        paddingRight: 5,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: active ? SELECTED_BORDER : 'transparent',
        borderRadius: 6,
        background: active ? SELECTED_BG : 'transparent',
        boxShadow: active ? 'var(--t-panel-shadow-soft, 0 1px 2px var(--t-shadow-color, transparent))' : 'none',
        color: active ? TEXT : MUTED,
        fontFamily: FONT,
        fontSize: 10.5,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        cursor: 'pointer',
        transition: 'background 140ms ease, color 140ms ease',
      }}
    >
      {glyph}
      {label}
    </button>
  );
}
