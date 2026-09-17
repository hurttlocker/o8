'use client';

import type { JudgmentProvider } from '@/lib/operator/judgment-default';
import { SettingsRow } from './grouped';
import { SettingsSegmented } from './shared';

export const JUDGMENT_PROVIDER_COPY = 'Advisory typed checks beside review decisions. When on, diff content leaves this machine and is sent to the provider';

export function JudgmentProviderRow({
  icon,
  value,
  busy,
  onChange,
}: {
  icon: React.ReactNode;
  value: JudgmentProvider;
  busy: boolean;
  onChange: (next: JudgmentProvider) => void;
}) {
  return (
    <SettingsRow
      icon={icon}
      label="Judgment referee"
      subtitle={JUDGMENT_PROVIDER_COPY}
      accessory={
        <SettingsSegmented
          value={value}
          onChange={(next) => { if (!busy) onChange(next as JudgmentProvider); }}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'typesafe', label: 'TypeSafe' },
          ]}
        />
      }
      disabled={busy}
      divider
    />
  );
}
