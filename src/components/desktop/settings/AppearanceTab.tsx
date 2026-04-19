'use client';

import { useTheme } from '@/lib/theme/context';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  HairlineRule,
  SectionLabel,
  TabBreadcrumb,
  TabHeading,
} from './shared';

// ── Theme Preview Card ──

function ThemePreviewCard({ theme, active, onSelect }: {
  theme: import('@/lib/theme/themes').ThemeTokens;
  active: boolean;
  onSelect: () => void;
}) {
  const p = theme.preview;

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        position: 'relative',
        width: 220,
        padding: 0,
        border: `1px solid ${RAMS_HAIRLINE_SOFT}`,
        borderRadius: 4,
        background: 'transparent',
        cursor: 'pointer',
        overflow: 'hidden',
        transition: 'border-color 160ms',
        fontFamily: APP_FONT_STACK,
      }}
    >
      {/* Mini dashboard preview */}
      <div style={{
        height: 130,
        background: p.bg,
        paddingTop: 8,
        paddingBottom: 8,
        paddingLeft: 8,
        paddingRight: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}>
        {/* Title bar */}
        <div style={{
          height: 10,
          borderRadius: 3,
          background: p.titlebar,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 4,
          paddingRight: 4,
          gap: 2,
        }}>
          <div style={{ width: 3, height: 3, borderRadius: '50%', background: '#ef4444', opacity: 0.7 }} />
          <div style={{ width: 3, height: 3, borderRadius: '50%', background: '#f59e0b', opacity: 0.7 }} />
          <div style={{ width: 3, height: 3, borderRadius: '50%', background: '#22c55e', opacity: 0.7 }} />
        </div>
        {/* Body */}
        <div style={{ flex: 1, display: 'flex', gap: 3 }}>
          {/* Nav rail */}
          <div style={{
            width: 14,
            borderRadius: 3,
            background: p.nav,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            paddingTop: 4,
            paddingBottom: 4,
            gap: 3,
          }}>
            <div style={{ width: 6, height: 6, borderRadius: 2, background: p.accent, opacity: 0.6 }} />
            <div style={{ width: 6, height: 2, borderRadius: 1, background: p.textMuted, opacity: 0.3 }} />
            <div style={{ width: 6, height: 2, borderRadius: 1, background: p.textMuted, opacity: 0.3 }} />
          </div>
          {/* Left panel */}
          <div style={{
            width: 46,
            borderRadius: 3,
            background: p.panel,
            paddingTop: 4,
            paddingBottom: 4,
            paddingLeft: 4,
            paddingRight: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          }}>
            <div style={{ height: 4, width: '70%', borderRadius: 1, background: p.text, opacity: 0.3 }} />
            <div style={{ height: 12, borderRadius: 2, background: p.bg, opacity: 0.6 }} />
            <div style={{ height: 12, borderRadius: 2, background: p.bg, opacity: 0.4 }} />
            <div style={{ height: 12, borderRadius: 2, background: p.bg, opacity: 0.3 }} />
          </div>
          {/* Center workspace */}
          <div style={{
            flex: 1,
            borderRadius: 3,
            background: p.bg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <div style={{ width: 16, height: 16, borderRadius: 3, border: `1px solid ${p.textMuted}40`, opacity: 0.3 }} />
          </div>
          {/* Right panel (chat) */}
          <div style={{
            width: 46,
            borderRadius: 3,
            background: p.panel,
            paddingTop: 4,
            paddingBottom: 4,
            paddingLeft: 4,
            paddingRight: 4,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            gap: 3,
          }}>
            <div style={{ height: 6, width: '80%', borderRadius: 2, background: p.accent, opacity: 0.25, alignSelf: 'flex-end' }} />
            <div style={{ height: 8, width: '60%', borderRadius: 2, background: p.textMuted, opacity: 0.15 }} />
            <div style={{ height: 10, borderRadius: 3, background: p.bg, opacity: 0.5 }} />
          </div>
        </div>
      </div>

      {/* Accent bar below preview (Braun crosshair reference) */}
      <div style={{
        height: 2,
        background: active ? RAMS_ACCENT : 'transparent',
      }} />

      {/* Label */}
      <div style={{
        paddingTop: 10,
        paddingBottom: 12,
        paddingLeft: 14,
        paddingRight: 14,
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
      }}>
        <div style={{
          fontSize: 13,
          fontWeight: 500,
          color: 'var(--t-text)',
          letterSpacing: '-0.01em',
        }}>
          {theme.name.toLowerCase()}
        </div>
        <div style={{
          fontFamily: MONO_FONT_STACK,
          fontSize: 10,
          fontWeight: 400,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: active ? RAMS_ACCENT : RAMS_INK_QUIET,
        }}>
          {active ? '(active)' : ''}
        </div>
      </div>
    </button>
  );
}

// ── Appearance Tab ──

export function AppearanceTab() {
  const { themeId, setTheme, themes: themeList } = useTheme();

  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 32,
      paddingBottom: 40,
      maxWidth: 780,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabBreadcrumb tab="appearance" />
      <TabHeading
        title="appearance"
        subtitle="Theme controls how o8 looks. Accent colors and status indicators stay consistent across themes."
      />

      <section>
        <SectionLabel number="01">THEME</SectionLabel>

        <div style={{
          display: 'flex',
          gap: 18,
          marginTop: 4,
          flexWrap: 'wrap',
        }}>
          {themeList.map((theme) => (
            <ThemePreviewCard
              key={theme.id}
              theme={theme}
              active={themeId === theme.id}
              onSelect={() => setTheme(theme.id)}
            />
          ))}
        </div>

        <div style={{ marginTop: 28 }}>
          <HairlineRule />
        </div>
      </section>
    </div>
  );
}
