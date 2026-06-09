'use client';

/**
 * Theme tab — Surface picks the look (Auto follows o8's transparency: glass when
 * on, solid when off; Glass is the locked tune; Solid is the opaque accessibility
 * look). The glass tune is finalized in code; the only live knob is Frost, kept
 * as the accessibility lever — more frost = more readable for low-vision users.
 * Persisted to localStorage by the shell.
 */
import { useEffect, useState } from 'react';
import { ICONS } from '../tokens';
import { SURFACE_PRESETS, type GlassControls, type VsSurface, TEXT_TERTIARY } from '../tokens';
import { SectionCard, SectionTitle, SectionHint, Segmented, Slider, ControlRow, PageHeader } from '../primitives';

const DOCK_THEME_KEY = 'o8:dock-theme';

export default function ThemeTab({ controls, onChange }: { controls: GlassControls; onChange: (c: GlassControls) => void }) {
  const auto = controls.surface === 'auto';

  const setSurface = (s: string) => {
    const surface = s as VsSurface;
    if (surface === 'auto') { onChange({ ...controls, surface }); return; }
    onChange({ ...controls, surface, ...SURFACE_PRESETS[surface] });
  };

  // Dock appearance. Writing localStorage fires `storage` in the dock window
  // (same origin), so it re-themes live.
  const [dock, setDock] = useState<'symon' | 'glass'>('symon');
  useEffect(() => {
    try { setDock(localStorage.getItem(DOCK_THEME_KEY) === 'glass' ? 'glass' : 'symon'); } catch { /* noop */ }
  }, []);
  const setDockTheme = (v: string) => {
    const next = v === 'glass' ? 'glass' : 'symon';
    setDock(next);
    try { localStorage.setItem(DOCK_THEME_KEY, next); } catch { /* noop */ }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader icon={ICONS.droplet} title="Theme" />

      <SectionCard>
        <SectionTitle icon={ICONS.eye}>Surface</SectionTitle>
        <SectionHint>Auto follows o8 — clear glass when o8&apos;s transparency is on, solid when it&apos;s off. Glass is the signature look; Solid is the high-contrast accessibility surface.</SectionHint>
        <Segmented
          full value={controls.surface} onChange={setSurface}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'glass', label: 'Glass' },
            { value: 'solid', label: 'Solid' },
          ]}
        />
      </SectionCard>

      <SectionCard>
        <SectionTitle icon={ICONS.sparkle}>Frost</SectionTitle>
        {auto ? (
          <p style={{ fontSize: 12.5, color: TEXT_TERTIARY }}>Following o8. Pick Glass or Solid to adjust frost yourself.</p>
        ) : (
          <>
            <SectionHint>Blurs the desktop behind the glass. Add frost if the clear glass is hard to read — it lifts contrast for low-vision use without leaving the Symon look.</SectionHint>
            <ControlRow label="Frost" detail="How much the background blurs behind the glass.">
              <Slider value={controls.frost} min={0} max={44} step={1} suffix="px" onChange={(v) => onChange({ ...controls, frost: v })} />
            </ControlRow>
          </>
        )}
      </SectionCard>

      <SectionCard>
        <SectionTitle icon={ICONS.microphone}>Dock</SectionTitle>
        <SectionHint>The Symon pill at the top of your screen. Keep the signature multicolor, or match it to the clear glass.</SectionHint>
        <Segmented
          full value={dock} onChange={setDockTheme}
          options={[{ value: 'symon', label: 'Symon' }, { value: 'glass', label: 'Glass' }]}
        />
      </SectionCard>
    </div>
  );
}
