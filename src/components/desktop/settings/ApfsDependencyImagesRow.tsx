'use client';

import { SettingsRow } from './grouped';

export function ApfsDependencyImagesRow({
  icon,
  persistedValue,
  effectiveOverride,
  busy,
  onToggle,
}: {
  icon: React.ReactNode;
  persistedValue: boolean;
  effectiveOverride: boolean | null;
  busy: boolean;
  onToggle: (next: boolean) => void;
}) {
  const overridden = effectiveOverride !== null;
  const effectiveValue = effectiveOverride ?? persistedValue;
  return (
    <SettingsRow
      icon={icon}
      label="APFS dependency images (pilot)"
      subtitle={overridden
        ? `Effective policy: ${effectiveValue ? 'On' : 'Off'} (overridden by environment)`
        : 'Reuse eligible npm dependencies from APFS disk images on macOS'}
      checked={effectiveValue}
      disabled={overridden || busy}
      onToggle={onToggle}
    />
  );
}
