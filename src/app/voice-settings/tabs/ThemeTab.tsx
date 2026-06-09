'use client';

/**
 * Theme tab — tune the glass. Surface picks the look (Auto follows o8's
 * transparency: glass when on, solid when off); Glass / Solid / Liquid seed the
 * sliders, then Frost / Clarity / Saturation fine-tune live. High saturation
 * flips on the Liquid-Glass specular sheen (Apple macOS 26 cue). Persisted to
 * localStorage by the shell.
 */
import { ICONS } from '../tokens';
import { SURFACE_PRESETS, type GlassControls, type VsSurface } from '../tokens';
import { SectionCard, SectionTitle, SectionHint, Segmented, Slider, ControlRow, PAGE_TITLE_STYLE } from '../primitives';
import { TEXT_TERTIARY } from '../tokens';

export default function ThemeTab({ controls, onChange }: { controls: GlassControls; onChange: (c: GlassControls) => void }) {
  const auto = controls.surface === 'auto';

  const setSurface = (s: string) => {
    const surface = s as VsSurface;
    if (surface === 'auto') { onChange({ ...controls, surface }); return; }
    onChange({ surface, ...SURFACE_PRESETS[surface] });
  };
  const setParam = (k: 'frost' | 'clarity' | 'saturate', v: number) => onChange({ ...controls, [k]: v });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <h1 style={PAGE_TITLE_STYLE}>Theme</h1>

      <SectionCard>
        <SectionTitle icon={ICONS.eye}>Surface</SectionTitle>
        <SectionHint>Auto follows o8 — transparent glass when o8&apos;s transparency is on, solid when it&apos;s off. Or pick a look to fine-tune.</SectionHint>
        <Segmented
          full value={controls.surface} onChange={setSurface}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'glass', label: 'Glass' },
            { value: 'solid', label: 'Solid' },
            { value: 'liquid', label: 'Liquid' },
          ]}
        />
      </SectionCard>

      <SectionCard>
        <SectionTitle icon={ICONS.sparkle}>Fine-tune</SectionTitle>
        {auto ? (
          <p style={{ fontSize: 12.5, color: TEXT_TERTIARY }}>Following o8. Pick Glass, Solid, or Liquid to adjust frost &amp; clarity yourself.</p>
        ) : (
          <>
            <ControlRow label="Frost" detail="How much the background blurs behind the glass.">
              <Slider value={controls.frost} min={0} max={44} step={1} suffix="px" onChange={(v) => setParam('frost', v)} />
            </ControlRow>
            <ControlRow label="Clarity" detail="How see-through the glass is — higher shows more of what's behind.">
              <Slider value={controls.clarity} min={0} max={100} step={1} suffix="%" onChange={(v) => setParam('clarity', v)} />
            </ControlRow>
            <ControlRow label="Saturation" detail="Color vividness behind the glass. 150%+ turns on the Liquid-Glass sheen.">
              <Slider value={controls.saturate} min={100} max={220} step={1} suffix="%" onChange={(v) => setParam('saturate', v)} />
            </ControlRow>
          </>
        )}
      </SectionCard>
    </div>
  );
}
