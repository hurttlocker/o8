'use client';

import { useEffect, useState } from 'react';
import { useTheme } from '@/lib/theme/context';
import {
  readTimelineVisible,
  subscribeTimelineVisible,
  writeTimelineVisible,
} from '@/lib/appearance/timeline';
import {
  THEME_ACCENT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_RING,
  THEME_ACCENT_SOFT,
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
  const [timelineVisible, setTimelineVisible] = useState(() => readTimelineVisible());

  useEffect(() => subscribeTimelineVisible(setTimelineVisible), []);

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
            Workspace
          </h3>
          <p style={{ fontSize: 12, color: 'var(--t-text-muted)', margin: '4px 0 0', lineHeight: 1.5 }}>
            Control the chrome around the main dashboard while we keep refining the timeline presentation.
          </p>
        </div>

        <button
          type="button"
          onClick={() => writeTimelineVisible(!timelineVisible)}
          aria-pressed={timelineVisible}
          style={{
            width: '100%',
            minHeight: 56,
            paddingTop: 14,
            paddingRight: 16,
            paddingBottom: 14,
            paddingLeft: 16,
            borderRadius: 16,
            border: `1px solid ${timelineVisible ? THEME_ACCENT_BORDER : 'var(--t-panel-border)'}`,
            background: timelineVisible ? THEME_ACCENT_SOFT : 'var(--t-bg-card)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            cursor: 'pointer',
            textAlign: 'left',
            transition: 'border-color 180ms ease, background 180ms ease, box-shadow 180ms ease',
            boxShadow: timelineVisible ? `0 0 0 3px ${THEME_ACCENT_RING}` : 'none',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
              Show Session Timeline
            </div>
            <div style={{ fontSize: 12, color: 'var(--t-text-muted)', lineHeight: 1.45 }}>
              Keeps the timeline rail visible under the title bar. Turn it off to simplify the dashboard.
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <span style={{
              fontSize: 11,
              fontWeight: 700,
              color: timelineVisible ? THEME_ACCENT : 'var(--t-text-muted)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}>
              {timelineVisible ? 'Shown' : 'Hidden'}
            </span>
            <div style={{
              width: 42,
              height: 24,
              borderRadius: 999,
              background: timelineVisible ? THEME_ACCENT : 'var(--t-divider-strong)',
              paddingTop: 2,
              paddingRight: 2,
              paddingBottom: 2,
              paddingLeft: 2,
              boxSizing: 'border-box',
              transition: 'background 180ms ease',
            }}>
              <div style={{
                width: 20,
                height: 20,
                borderRadius: 999,
                background: '#ffffff',
                transform: timelineVisible ? 'translateX(18px)' : 'translateX(0)',
                transition: 'transform 180ms ease',
                boxShadow: '0 2px 8px rgba(15, 23, 42, 0.18)',
              }} />
            </div>
          </div>
        </button>
      </div>

    </div>
  );
}
