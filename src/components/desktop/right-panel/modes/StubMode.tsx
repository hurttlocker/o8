'use client';

import type { AmbientLinkedRef, AmbientMode } from '../useAmbientMode';

export function StubMode({
  mode,
  linkedRef,
}: {
  mode: Extract<AmbientMode, 'issue' | 'pr'>;
  linkedRef: AmbientLinkedRef | null;
}) {
  const label = mode === 'issue' ? 'ISSUE' : 'PR';
  const idLabel = linkedRef ? (mode === 'issue' ? `#${linkedRef.id}` : `PR #${linkedRef.id}`) : null;
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 24,
        paddingRight: 16,
        paddingBottom: 24,
        paddingLeft: 16,
        color: 'var(--t-text-muted)',
        fontSize: 12,
        lineHeight: 1.5,
        letterSpacing: '-0.01em',
        textAlign: 'center',
      }}
    >
      [{label}] · coming soon{idLabel ? ` · ${idLabel}` : ''}
    </div>
  );
}
