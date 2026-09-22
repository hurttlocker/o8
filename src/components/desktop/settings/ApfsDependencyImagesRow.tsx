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
      label="Reuse dependencies (APFS)"
      subtitle={overridden
        ? `Effective policy: ${effectiveValue ? 'On' : 'Off'} (overridden by environment)`
        : 'On compatible Macs, reuse npm dependencies to save setup time and disk space. Otherwise, install normally.'}
      checked={effectiveValue}
      disabled={overridden || busy}
      onToggle={onToggle}
    />
  );
}
