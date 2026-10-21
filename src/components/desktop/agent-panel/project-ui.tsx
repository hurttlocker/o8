'use client';

import type { CSSProperties, ReactNode } from 'react';
import { RamsButton } from '../settings/shared';

export const projectInputStyle: CSSProperties = {
  boxSizing: 'border-box', width: '100%', minWidth: 0, height: 36,
  paddingLeft: 11, paddingRight: 11, border: '1px solid var(--t-divider-subtle)',
  borderRadius: 10, background: 'var(--t-input-bg)', color: 'var(--t-text)',
  fontFamily: 'var(--font-sans-system)', fontSize: 13, fontWeight: 300,
};

export function ProjectButton({ children, onClick, disabled, busy, primary = false }: {
  children: ReactNode; onClick: () => void; disabled?: boolean; busy?: boolean; primary?: boolean;
}) {
  return <RamsButton disabled={disabled} busy={busy} onClick={onClick} variant={primary ? 'solid' : 'ghost'}>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{children}</span>
  </RamsButton>;
}
