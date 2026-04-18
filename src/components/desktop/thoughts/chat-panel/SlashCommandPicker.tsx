'use client';

import type { OrchestratorSlashCommandDefinition } from '@/lib/slash-commands';

interface SlashCommandPickerProps {
  suggestions: OrchestratorSlashCommandDefinition[];
  activeIndex: number;
  onSelect: (definition: OrchestratorSlashCommandDefinition) => void;
}

function commandIcon(name: OrchestratorSlashCommandDefinition['name']) {
  switch (name) {
    case 'compact':
      return (
        <path d="M6 7h12M8 12h8M10 17h4" />
      );
    case 'clear':
      return (
        <>
          <path d="M4 6h16" />
          <path d="M7 6v11a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6" />
          <path d="M10 10v5M14 10v5" />
        </>
      );
    case 'focus':
      return (
        <>
          <path d="M9 3H5a2 2 0 0 0-2 2v4" />
          <path d="M15 3h4a2 2 0 0 1 2 2v4" />
          <path d="M21 15v4a2 2 0 0 1-2 2h-4" />
          <path d="M3 15v4a2 2 0 0 0 2 2h4" />
        </>
      );
    case 'status':
      return (
        <>
          <path d="M6 18V9" />
          <path d="M12 18V5" />
          <path d="M18 18v-7" />
        </>
      );
    case 'recall':
      return (
        <>
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <path d="M3 4v5h5" />
        </>
      );
    case 'handoff':
      return (
        <>
          <path d="M8 7h8" />
          <path d="M12 3l4 4-4 4" />
          <path d="M16 17H8" />
          <path d="M12 13l-4 4 4 4" />
        </>
      );
  }
}

export function SlashCommandPicker({ suggestions, activeIndex, onSelect }: SlashCommandPickerProps) {
  if (suggestions.length === 0) return null;

  return (
    <div style={{
      position: 'absolute',
      bottom: '100%',
      left: 0,
      right: 0,
      marginBottom: 8,
      padding: 6,
      borderRadius: 18,
      background: 'linear-gradient(180deg, rgba(255,255,255,0.92), rgba(248,250,252,0.96))',
      border: '1px solid rgba(148, 163, 184, 0.16)',
      boxShadow: '0 18px 42px rgba(15, 23, 42, 0.08)',
      backdropFilter: 'blur(22px)',
      zIndex: 20,
    }}>
      <div style={{
        padding: '4px 10px 8px',
        fontSize: 9.5,
        fontWeight: 700,
        color: 'var(--t-text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
      }}>
        Slash commands
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {suggestions.map((suggestion, index) => {
          const active = index === activeIndex;
          return (
            <button
              key={suggestion.command}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(suggestion)}
              style={{
                display: 'grid',
                gridTemplateColumns: '24px minmax(0, 1fr)',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '10px 12px',
                borderRadius: 14,
                border: 'none',
                background: active ? 'rgba(37, 99, 235, 0.08)' : 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{
                width: 24,
                height: 24,
                borderRadius: 999,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: active ? 'rgba(37, 99, 235, 0.12)' : 'rgba(148, 163, 184, 0.08)',
                color: active ? '#2563eb' : '#64748b',
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  {commandIcon(suggestion.name)}
                </svg>
              </span>

              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                  <span style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: active ? '#1d4ed8' : 'var(--t-text)',
                    fontFamily: '"SFMono-Regular", ui-monospace, Menlo, monospace',
                    whiteSpace: 'nowrap',
                  }}>
                    {suggestion.command}
                  </span>
                  {suggestion.argHint ? (
                    <span style={{
                      fontSize: 10.5,
                      color: 'var(--t-text-faint)',
                      fontFamily: '"SFMono-Regular", ui-monospace, Menlo, monospace',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {suggestion.argHint}
                    </span>
                  ) : null}
                </div>
                <div style={{
                  fontSize: 11,
                  lineHeight: 1.45,
                  color: 'var(--t-text-muted)',
                  marginTop: 2,
                  fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                }}>
                  {suggestion.description}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
