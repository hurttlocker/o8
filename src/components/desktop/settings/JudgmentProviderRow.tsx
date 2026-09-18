'use client';

import type { JudgmentPath } from '@/lib/judgment/route';
import type { JudgmentProvider } from '@/lib/operator/judgment-default';
import { SettingsRow } from './grouped';
import { SettingsSegmented } from './shared';

export const JUDGMENT_PROVIDER_COPY = 'Advisory typed checks beside review decisions. When on, diff content leaves this machine and is sent to the provider';

/** Subtitle lead for each path the route resolver can report (#2485). */
export const JUDGMENT_PATH_LABELS: Record<JudgmentPath, string> = {
  off: 'Off',
  key: 'Using your key',
  plan: 'Covered by your plan',
  allowance: 'Beta allowance',
  none: 'No key or plan token found',
};

/** `none` under `typesafe` only ever looks for a key. */
export const JUDGMENT_NO_KEY_LABEL = 'No key found';

export const JUDGMENT_MANAGED_UNAVAILABLE_NOTE = 'Managed is not yet available on this install';

export function judgmentProviderSubtitle(value: JudgmentProvider, path: JudgmentPath | undefined, managedVisible: boolean): string {
  const lead = path === 'none' && value === 'typesafe'
    ? JUDGMENT_NO_KEY_LABEL
    : path ? JUDGMENT_PATH_LABELS[path] : value === 'off' ? JUDGMENT_PATH_LABELS.off : null;
  const parts = [lead, JUDGMENT_PROVIDER_COPY];
  if (value === 'managed' && !managedVisible) parts.push(JUDGMENT_MANAGED_UNAVAILABLE_NOTE);
  return `${parts.filter(Boolean).join('. ')}.`;
}

export function JudgmentProviderRow({
  icon,
  value,
  path,
  managedVisible,
  busy,
  onChange,
}: {
  icon: React.ReactNode;
  value: JudgmentProvider;
  /** The path from the route resolver, served by the operator-defaults route. */
  path?: JudgmentPath;
  /** The `judgmentManagedOptionVisible` operator flag. */
  managedVisible: boolean;
  busy: boolean;
  onChange: (next: JudgmentProvider) => void;
}) {
  const options = [
    { value: 'off', label: 'Off' },
    { value: 'typesafe', label: 'Bring your own key' },
  ];
  // A hand-written `managed` stays visible and selected with the flag off, so
  // the row never hides or rewrites the stored value.
  if (managedVisible || value === 'managed') options.push({ value: 'managed', label: 'Managed' });
  return (
    <SettingsRow
      icon={icon}
      label="Judgment referee"
      subtitle={judgmentProviderSubtitle(value, path, managedVisible)}
      accessory={
        <SettingsSegmented
          value={value}
          onChange={(next) => { if (!busy) onChange(next as JudgmentProvider); }}
          options={options}
        />
      }
      disabled={busy}
      divider
    />
  );
}
