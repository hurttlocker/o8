'use client';

/**
 * Theme tab — Surface picks the look (Auto follows o8's transparency: glass when
 * on, solid when off; Glass is the locked tune; Solid is the opaque, high-contrast
 * accessibility surface). The glass tune is finalized in code. Dock matches the
 * pill to the glass or keeps the signature multicolor. Persisted to localStorage.
 */
import { useEffect, useState } from 'react';
import { ICONS } from '../tokens';
import { SURFACE_PRESETS, type GlassControls, type VsSurface } from '../tokens';
import { SectionCard, SectionTitle, SectionHint, Segmented, PageHeader } from '../primitives';

const DOCK_THEME_KEY = 'o8:dock-theme';

export default function ThemeTab({ controls, onChange }: { controls: GlassControls; onChange: (c: GlassControls) => void }) {
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
