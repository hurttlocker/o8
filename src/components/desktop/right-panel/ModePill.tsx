'use client';

import type { AmbientMode } from './useAmbientMode';

const MODE_LABEL: Record<AmbientMode, string> = {
  stream: 'STREAM',
  diff: 'DIFF',
  pulse: 'PULSE',
  issue: 'ISSUE',
  pr: 'PR',
};

export function ModePill({
  mode,
  locked,
  onToggleLock,
}: {
  mode: AmbientMode;
  locked: boolean;
  onToggleLock: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggleLock}
      title={locked ? 'Locked to current mode' : 'Auto mode'}
      aria-label={locked ? 'Unlock right panel mode' : 'Lock right panel mode'}
      aria-pressed={locked}
      style={{
        minHeight: 44,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 9,
        paddingTop: 0,
        paddingRight: 10,
        paddingBottom: 0,
        paddingLeft: 10,
        borderWidth: 0,
        borderRadius: 8,
        background: 'transparent',
        color: 'var(--t-text-muted)',
        cursor: 'pointer',
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
        transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = 'var(--t-hover)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent';
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          borderWidth: 1.5,
          borderStyle: 'solid',
          borderColor: 'var(--t-brand-orange, #FF5A1F)',
          background: locked ? 'var(--t-brand-orange, #FF5A1F)' : 'transparent',
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}
      >
        [{MODE_LABEL[mode]}]
      </span>
    </button>
  );
}
