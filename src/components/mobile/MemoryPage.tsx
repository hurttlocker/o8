'use client';

import { memo, useEffect, useState } from 'react';
import type { Directive } from '@/lib/cortex/directives-types';
import { useTheme } from './ThemeContext';

type ThemeColors = ReturnType<typeof useTheme>['colors'];

interface MemoryPageProps {
  onBack: () => void;
  onInjectText?: (text: string) => void;
}

function sectionHeaderStyle(colors: ThemeColors) {
  return {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: colors.textSecondary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: 8,
    padding: '0 4px',
  };
}

export default memo(function MemoryPage({ onBack }: MemoryPageProps) {
  const { colors } = useTheme();
  const [directives, setDirectives] = useState<Directive[]>([]);
  const [directivesLoading, setDirectivesLoading] = useState(false);

  useEffect(() => {
    setDirectivesLoading(true);
    fetch('/api/directives')
      .then((response) => response.json())
      .then((data) => {
        setDirectives(data.directives ?? []);
        setDirectivesLoading(false);
      })
      .catch(() => setDirectivesLoading(false));
  }, []);

  return (
    <div
      style={{
        padding: '0 12px 24px',
        width: '100%',
        boxSizing: 'border-box',
        background: colors.bg,
        minHeight: '100%',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            type="button"
            onClick={onBack}
            style={{
              minHeight: 44,
              padding: '0 16px',
              borderRadius: 12,
              border: 'none',
              background: colors.blueAccent,
              color: colors.text,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            Done
          </button>
          <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.03em', color: colors.text, margin: 0 }}>
            Memory
          </h1>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={sectionHeaderStyle(colors)}>Operator Directives</span>
        {directivesLoading ? (
          <div
            style={{
              padding: '32px 20px',
              textAlign: 'center',
              color: colors.textSecondary,
              fontSize: 14,
              borderRadius: 14,
              background: colors.cardBg,
              border: `1px solid ${colors.cardBorder}`,
            }}
          >
            Loading directives...
          </div>
        ) : directives.length === 0 ? (
          <div
            style={{
              padding: '32px 20px',
              textAlign: 'center',
              color: colors.textSecondary,
              fontSize: 14,
              borderRadius: 14,
              background: colors.cardBg,
              border: `1px solid ${colors.cardBorder}`,
            }}
          >
            No directives configured
          </div>
        ) : (
          directives.map((d) => {
            const contentLines = d.content.split('\n');
            const preview = contentLines.slice(0, 2).join(' ');
            const truncated = preview.length > 120 ? preview.slice(0, 120) + '...' : preview;

            return (
              <div
                key={d.id}
                style={{
                  padding: '12px 14px',
                  borderRadius: 14,
                  background: colors.cardBg,
                  border: `1px solid ${colors.cardBorder}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: 700,
                      color: colors.text,
                      letterSpacing: '-0.01em',
                    }}
                  >
                    {d.title}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: d.scope === 'global' ? '#0a84ff' : '#30d158',
                      background: d.scope === 'global' ? 'rgba(10,132,255,0.12)' : 'rgba(48,209,88,0.12)',
                      border: d.scope === 'global' ? '1px solid rgba(10,132,255,0.16)' : '1px solid rgba(48,209,88,0.16)',
                      borderRadius: 999,
                      paddingTop: 2,
                      paddingBottom: 2,
                      paddingLeft: 6,
                      paddingRight: 6,
                    }}
                  >
                    {d.scope === 'global' ? 'Global' : d.repoName ?? 'Repo'}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      color: colors.textSecondary,
                      fontFamily: '"SF Mono", ui-monospace, monospace',
                      marginLeft: 'auto',
                    }}
                  >
                    P{d.priority}
                  </span>
                </div>
                <p
                  style={{
                    margin: 0,
                    fontSize: 13,
                    lineHeight: 1.5,
                    color: colors.textSecondary,
                  }}
                >
                  {truncated}
                </p>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
});
