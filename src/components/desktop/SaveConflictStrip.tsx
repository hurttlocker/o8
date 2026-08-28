'use client';

import type { CSSProperties } from 'react';

export interface SaveConflict {
  content: string | null;
  contentHash: string | null;
}

const actionStyle: CSSProperties = {
  minHeight: 44,
  paddingTop: 0,
  paddingRight: 12,
  paddingBottom: 0,
  paddingLeft: 12,
  border: 'none',
  borderRadius: 7,
  fontFamily: 'var(--font-sans-system)',
  fontSize: 11,
  fontWeight: 300,
  letterSpacing: '-0.1px',
};

export function SaveConflictStrip({
  busy,
  onReload,
  onOverwrite,
}: {
  busy: boolean;
  onReload: () => void;
  onOverwrite: () => void;
}) {
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        minHeight: 52,
        paddingTop: 4,
        paddingRight: 12,
        paddingBottom: 4,
        paddingLeft: 16,
        borderBottom: '1px solid var(--t-divider-subtle)',
        background: 'var(--t-input-bg)',
        color: 'var(--t-text)',
        fontFamily: 'var(--font-sans-system)',
        flexShrink: 0,
      }}
    >
      <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px' }}>
        Changed on disk while you were editing
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <button
          type="button"
          disabled={busy}
          onClick={onReload}
          style={{
            ...actionStyle,
            background: 'var(--t-bg-card)',
            color: 'var(--t-text)',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}
        >
          Reload
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onOverwrite}
          style={{
            ...actionStyle,
            background: 'transparent',
            color: 'var(--t-danger)',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? 'Overwriting…' : 'Overwrite'}
        </button>
      </div>
    </div>
  );
}
