'use client';

import { useTheme } from '@/lib/theme/context';
import type { ThemePalette, SurfaceMode } from '@/lib/theme/registry';
import {
  APP_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  RAMS_CONTROL_ACTIVE_BORDER,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
import { GroupFootnote, GroupHeader } from './grouped';

// ── Palette Preview Card ────────────────────────────────────────────────────

function PalettePreviewCard({
  palette,
  name,
  description,
  glass,
  allGlass = false,
  active,
  onSelect,
}: {
  palette: ThemePalette;
  name: string;
  description: string;
  glass: boolean;
  allGlass?: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  const p = palette.preview;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={name}
      aria-pressed={active}
      style={{
        position: 'relative',
        width: '100%',
        minWidth: 0,
        textAlign: 'left',
        padding: 0,
        border: `1px solid ${active ? RAMS_CONTROL_ACTIVE_BORDER : RAMS_HAIRLINE_SOFT}`,
        borderRadius: 9,
        background: 'transparent',
        cursor: 'pointer',
        overflow: 'hidden',
        transition: 'border-color 160ms',
        fontFamily: APP_FONT_STACK,
      }}
    >
      <div
        style={{
          height: 96,
          background: glass ? `linear-gradient(135deg, ${p.accent}55, ${p.bg} 55%, ${p.accent}33)` : p.bg,
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 8,
          paddingRight: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <div
          style={{
            height: 10,
            borderRadius: 3,
            background: glass ? `${p.titlebar}99` : p.titlebar,
            display: 'flex',
            alignItems: 'center',
            paddingLeft: 4,
            paddingRight: 4,
            gap: 2,
          }}
        >
          <div style={{ width: 3, height: 3, borderRadius: '50%', background: '#ef4444', opacity: 0.7 }} />
          <div style={{ width: 3, height: 3, borderRadius: '50%', background: '#f59e0b', opacity: 0.7 }} />
          <div style={{ width: 3, height: 3, borderRadius: '50%', background: '#22c55e', opacity: 0.7 }} />
        </div>
        <div style={{ flex: 1, display: 'flex', gap: 3 }}>
          <div
            style={{
              width: 14,
              borderRadius: 3,
              background: glass ? `${p.nav}88` : p.nav,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              paddingTop: 4,
              paddingBottom: 4,
              gap: 3,
            }}
          >
            <div style={{ width: 6, height: 6, borderRadius: 2, background: p.accent, opacity: 0.6 }} />
            <div style={{ width: 6, height: 2, borderRadius: 1, background: p.textMuted, opacity: 0.3 }} />
            <div style={{ width: 6, height: 2, borderRadius: 1, background: p.textMuted, opacity: 0.3 }} />
          </div>
          <div
            style={{
              width: 46,
              borderRadius: 3,
              background: glass ? `${p.panel}99` : p.panel,
              paddingTop: 4,
              paddingBottom: 4,
              paddingLeft: 4,
              paddingRight: 4,
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
            }}
          >
            <div style={{ height: 4, width: '70%', borderRadius: 1, background: p.text, opacity: 0.3 }} />
            <div style={{ height: 12, borderRadius: 2, background: p.bg, opacity: 0.6 }} />
            <div style={{ height: 12, borderRadius: 2, background: p.bg, opacity: 0.4 }} />
            <div style={{ height: 12, borderRadius: 2, background: p.bg, opacity: 0.3 }} />
          </div>
          <div
            style={{
              flex: 1,
              borderRadius: 3,
              background: allGlass ? `${p.bg}55` : p.bg,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: 3,
                border: `1px solid ${p.textMuted}40`,
                opacity: 0.3,
              }}
            />
          </div>
          <div
            style={{
              width: 46,
              borderRadius: 3,
              background: glass ? `${p.panel}99` : p.panel,
              paddingTop: 4,
              paddingBottom: 4,
              paddingLeft: 4,
              paddingRight: 4,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
              gap: 3,
            }}
          >
            <div style={{ height: 6, width: '80%', borderRadius: 2, background: p.accent, opacity: 0.25, alignSelf: 'flex-end' }} />
            <div style={{ height: 8, width: '60%', borderRadius: 2, background: p.textMuted, opacity: 0.15 }} />
            <div style={{ height: 10, borderRadius: 3, background: p.bg, opacity: 0.5 }} />
          </div>
        </div>
      </div>

      <div style={{ height: 2, background: active ? RAMS_ACCENT : 'transparent' }} />

      <div
        style={{
          paddingTop: 10,
          paddingBottom: 12,
          paddingLeft: 14,
          paddingRight: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--t-text)' }}>{name}</span>
          <span style={{ fontSize: 10, color: active ? RAMS_ACCENT : RAMS_INK_QUIET }}>
            {active ? 'Selected' : ''}
          </span>
        </div>
        <span style={{ fontSize: 11.5, lineHeight: 1.4, color: 'var(--t-text-muted)' }}>{description}</span>
      </div>
    </button>
  );
}

// Each card applies a complete look using the existing persisted theme settings.
export function AppearanceTab() {
  const {
    paletteId,
    setPalette,
    palettes,
    surface,
    setReduceTransparency,
    workspaceGlass,
    setWorkspaceGlass,
  } = useTheme();
  const options = palettes.flatMap((palette) => (['solid', 'glass'] as SurfaceMode[]).map((surface) => ({
    id: `${palette.id}-${surface}`,
    palette,
    surface,
    name: `${palette.name} ${surface === 'solid' ? 'Solid' : 'Glass'}`,
    description: surface === 'solid' ? 'Opaque panels and workspace.' : 'Glass panels with an opaque workspace.',
  })));
  const darkPalette = palettes.find((palette) => palette.id === 'dark');

  return (
    <div style={{ paddingTop: 8, paddingLeft: 8, paddingRight: 32, paddingBottom: 40, maxWidth: SETTINGS_CONTENT_MAX_WIDTH, fontFamily: APP_FONT_STACK }}>
      <TabHeading title="appearance" subtitle="Choose a look for your workspace. Changes apply immediately." />
      <section>
        <GroupHeader>Theme</GroupHeader>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 12, marginTop: 4, maxWidth: 1000 }}>
          {options.map((option) => (
            <PalettePreviewCard
              key={option.id}
              palette={option.palette}
              name={option.name}
              description={option.description}
              glass={option.surface === 'glass'}
              active={!workspaceGlass && paletteId === option.palette.id && surface === option.surface}
              onSelect={() => {
                setWorkspaceGlass(false);
                setPalette(option.palette.id);
                setReduceTransparency(option.surface === 'solid' ? 'on' : 'off');
              }}
            />
          ))}
          {darkPalette ? (
            <PalettePreviewCard
              palette={darkPalette}
              name="All Glass"
              description="Glass across the entire window."
              glass
              allGlass
              active={workspaceGlass}
              onSelect={() => setWorkspaceGlass(true)}
            />
          ) : null}
        </div>
        <GroupFootnote>Glass lets your wallpaper show through in the macOS desktop app. Solid keeps surfaces opaque for clearer contrast. Other platforms may use solid surfaces.</GroupFootnote>
      </section>
    </div>
  );
}
