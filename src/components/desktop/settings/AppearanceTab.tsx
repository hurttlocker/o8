'use client';

import { useState, useEffect } from 'react';
import { useTheme } from '@/lib/theme/context';
import {
  readNavRailHoverExpandEnabled,
  subscribeNavRailHoverExpandEnabled,
  writeNavRailHoverExpandEnabled,
} from '@/lib/appearance/nav-rail';
import {
  THEME_ACCENT,
  THEME_ACCENT_SOFT,
  THEME_ACCENT_SOFT_STRONG,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_RING,
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
        width: 200,
        padding: 0,
        border: active ? `2px solid ${THEME_ACCENT}` : '2px solid var(--t-panel-border)',
        borderRadius: 16,
        background: 'var(--t-panel-translucent)',
        cursor: 'pointer',
        overflow: 'hidden',
        transition: 'border-color 200ms, box-shadow 200ms, transform 200ms',
        boxShadow: active ? `0 0 0 3px ${THEME_ACCENT_RING}` : 'var(--t-panel-shadow)',
      }}
    >
      {/* Mini dashboard preview */}
      <div style={{
        height: 120,
        background: p.bg,
        padding: 8,
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
          padding: '0 4px',
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
            padding: '4px 0',
            gap: 3,
          }}>
            <div style={{ width: 6, height: 6, borderRadius: 2, background: p.accent, opacity: 0.6 }} />
            <div style={{ width: 6, height: 2, borderRadius: 1, background: p.textMuted, opacity: 0.3 }} />
            <div style={{ width: 6, height: 2, borderRadius: 1, background: p.textMuted, opacity: 0.3 }} />
          </div>
          {/* Left panel */}
          <div style={{
            width: 44,
            borderRadius: 3,
            background: p.panel,
            padding: 4,
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
            width: 44,
            borderRadius: 3,
            background: p.panel,
            padding: 4,
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

      {/* Label */}
      <div style={{
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div>
          <div style={{
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--t-text)',
            textAlign: 'left',
          }}>
            {theme.name}
          </div>
          <div style={{
            fontSize: 11,
            color: 'var(--t-text-muted)',
            textAlign: 'left',
            marginTop: 1,
          }}>
            {theme.description}
          </div>
        </div>
        {active && (
          <div style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            background: THEME_ACCENT,
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
          }}>
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
        )}
      </div>
    </button>
  );
}

// ── Appearance Tab ──

export function AppearanceTab() {
  const { themeId, setTheme, themes: themeList } = useTheme();
  const [fleetMode, setFleetMode] = useState<'smart' | 'all'>(() => {
    if (typeof window === 'undefined') return 'smart';
    return (localStorage.getItem('cortex-ide-fleet-mode') as 'smart' | 'all') ?? 'smart';
  });
  const [navRailHoverExpand, setNavRailHoverExpand] = useState(() => readNavRailHoverExpandEnabled());

  useEffect(() => subscribeNavRailHoverExpandEnabled(setNavRailHoverExpand), []);

  const handleFleetModeChange = (mode: 'smart' | 'all') => {
    setFleetMode(mode);
    localStorage.setItem('cortex-ide-fleet-mode', mode);
  };

  const handleNavRailHoverExpandChange = (enabled: boolean) => {
    setNavRailHoverExpand(enabled);
    writeNavRailHoverExpandEnabled(enabled);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Section: Themes */}
      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 14,
        padding: 24,
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
      }}>
        <div style={{ marginBottom: 4 }}>
          <h3 style={{ fontSize: 17, fontWeight: 700, color: 'var(--t-text)', margin: 0 }}>
            Theme
          </h3>
          <p style={{ fontSize: 12, color: 'var(--t-text-muted)', margin: '4px 0 0' }}>
            Choose how o8 looks. Accent colors and status indicators stay consistent across themes.
          </p>
        </div>

        <div style={{
          display: 'flex',
          gap: 16,
          marginTop: 20,
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
      </div>

      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 14,
        padding: 24,
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
      }}>
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 17, fontWeight: 700, color: 'var(--t-text)', margin: 0 }}>
            Motion
          </h3>
          <p style={{ fontSize: 12, color: 'var(--t-text-muted)', margin: '4px 0 0' }}>
            Reduce movement in the shell without changing the underlying layout or actions.
          </p>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={navRailHoverExpand}
          onClick={() => handleNavRailHoverExpandChange(!navRailHoverExpand)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '14px 16px',
            borderRadius: 12,
            border: navRailHoverExpand
              ? `1.5px solid ${THEME_ACCENT_BORDER}`
              : '1px solid var(--t-panel-border)',
            background: navRailHoverExpand
              ? THEME_ACCENT_SOFT
              : 'var(--t-bg-card, rgba(148, 163, 184, 0.08))',
            cursor: 'pointer',
            textAlign: 'left',
            transition: 'border-color 140ms ease, background 140ms ease, box-shadow 140ms ease',
            boxShadow: navRailHoverExpand
              ? `0 10px 28px ${THEME_ACCENT_RING}`
              : 'none',
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)' }}>
                Expand nav rail on hover
              </span>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 8px',
                borderRadius: 999,
                background: navRailHoverExpand ? THEME_ACCENT_SOFT_STRONG : 'var(--t-divider-subtle)',
                color: navRailHoverExpand ? THEME_ACCENT : 'var(--t-text-secondary)',
                fontSize: 11,
                fontWeight: 700,
              }}>
                <span style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: navRailHoverExpand ? THEME_ACCENT : 'var(--t-text-muted)',
                }} />
                {navRailHoverExpand ? 'On' : 'Off'}
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 5, lineHeight: 1.45 }}>
              When off, the left rail stays compact at all times and users open sections with clicks only.
            </div>
          </div>

          <div style={{
            width: 42,
            height: 24,
            borderRadius: 999,
            background: navRailHoverExpand ? THEME_ACCENT : 'var(--t-divider-strong)',
            position: 'relative',
            flexShrink: 0,
            boxShadow: navRailHoverExpand ? `inset 0 0 0 1px ${THEME_ACCENT_BORDER}` : 'inset 0 0 0 1px var(--t-divider)',
            transition: 'background 140ms ease',
          }}>
            <span style={{
              position: 'absolute',
              top: 3,
              left: navRailHoverExpand ? 21 : 3,
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: 'var(--t-text-strong)',
              boxShadow: '0 2px 8px rgba(15, 23, 42, 0.28)',
              transition: 'left 140ms ease',
            }} />
          </div>
        </button>
      </div>

      {/* Section: Fleet Display */}
      <div style={{
        background: 'var(--t-panel)',
        borderRadius: 14,
        padding: 24,
        border: '1px solid var(--t-panel-border)',
        boxShadow: 'var(--t-panel-shadow)',
      }}>
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 17, fontWeight: 700, color: 'var(--t-text)', margin: 0 }}>
            Fleet Display
          </h3>
          <p style={{ fontSize: 12, color: 'var(--t-text-muted)', margin: '4px 0 0' }}>
            Control how agents and their sessions appear in the sidebar.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {([
            {
              id: 'smart' as const,
              label: 'Agents + Updates',
              desc: 'Show all main agent surfaces and one card per sub-agent. Cron runs update existing cards instead of creating new ones.',
            },
            {
              id: 'all' as const,
              label: 'All Agents + Crons',
              desc: 'Show every session including individual cron runs. More detail, more cards.',
            },
          ]).map((option) => (
            <div
              key={option.id}
              onClick={() => handleFleetModeChange(option.id)}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 12,
                padding: '12px 14px', borderRadius: 10,
                border: fleetMode === option.id
                  ? `1.5px solid ${THEME_ACCENT_BORDER}`
                  : '1px solid var(--t-panel-border)',
                background: fleetMode === option.id
                  ? THEME_ACCENT_SOFT
                  : 'var(--t-bg-card, rgba(148, 163, 184, 0.08))',
                cursor: 'pointer',
                transition: 'all 120ms ease',
                boxShadow: fleetMode === option.id ? `0 10px 24px ${THEME_ACCENT_RING}` : 'none',
              }}
            >
              <div style={{
                width: 16, height: 16, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                border: fleetMode === option.id
                  ? `5px solid ${THEME_ACCENT}`
                  : '2px solid var(--t-text-muted)',
                background: fleetMode === option.id ? 'var(--t-panel)' : 'transparent',
                transition: 'all 120ms ease',
              }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)' }}>
                  {option.label}
                </div>
                <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 2, lineHeight: 1.4 }}>
                  {option.desc}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
