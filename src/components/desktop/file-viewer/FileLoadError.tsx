'use client';

import { RamsButton } from '../settings/shared';

export function FileLoadError({ filePath, error, onRetry }: {
  filePath: string;
  error: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert" style={{
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8,
      paddingTop: 20, paddingRight: 20, paddingBottom: 20, paddingLeft: 20,
      color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)',
      fontSize: 13, fontWeight: 300, letterSpacing: '-0.1px',
    }}>
      <span>Could not load {filePath.split('/').pop() ?? filePath}</span>
      <span style={{ color: 'var(--t-text-muted)', overflowWrap: 'anywhere' }}>{error}</span>
      <span style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>
        Retry, or reopen the file from Search if it moved or its repository changed.
      </span>
      <RamsButton variant="ghost" onClick={onRetry}>Retry</RamsButton>
    </div>
  );
}
