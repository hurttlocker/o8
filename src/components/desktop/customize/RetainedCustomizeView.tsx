'use client';

import { useState, type ReactNode } from 'react';

/** Keep the current customization view intact while its file opens in the workspace. */
export function RetainedCustomizeView({ active, children }: { active: boolean; children?: ReactNode }) {
  const [opened, setOpened] = useState(active);
  if (active && !opened) setOpened(true);
  if (!active && !opened) return null;
  return (
    <div
      hidden={!active}
      aria-hidden={!active}
      inert={!active}
      style={{ flex: 1, minHeight: 0, display: active ? 'flex' : 'none', flexDirection: 'column', overflow: 'hidden' }}
    >
      {children}
    </div>
  );
}
