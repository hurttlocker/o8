'use client';

import type { SetupRuntime } from '@/lib/setup/runtime-recommendation';
import { resolveSubscriptionProfileRouting } from '@/lib/operator/subscription-profile';
import { SettingsRow } from './grouped';
import { SettingsToggleButton } from './shared';
import type { OperatorDefaultsResponse, DispatchRuntime } from './dispatch-shared';

export function WorkerPoolSettings({ data, inventory, busy, onChange }: {
  data: OperatorDefaultsResponse;
  inventory: SetupRuntime[] | null;
  busy: boolean;
  onChange: (pool: DispatchRuntime[]) => void;
}) {
  const configured = data.values.workerRuntimes ?? [data.values.defaultDispatchRuntime];
  const pool = data.sources.workerRuntimes === 'file' ? configured
    : [...new Set([data.values.defaultDispatchRuntime, ...configured])];
  return <>
    {(inventory ?? []).filter(item => item.installed || item.available || pool.includes(item.id)).map(item => {
      const selected = pool.includes(item.id);
      const profile = resolveSubscriptionProfileRouting({ profile: data.values.subscriptionProfile, requestedRuntime: item.id });
      const disabled = busy || data.sources.workerRuntimes === 'env'
        || (selected ? pool.length === 1 || item.id === data.values.defaultDispatchRuntime : !item.available || !profile.ok);
      return <SettingsRow key={item.id} label={item.label}
        subtitle={!profile.ok ? profile.message : !item.available ? item.detail : item.id === data.values.defaultDispatchRuntime ? 'Preferred worker. Change the default before removing it.' : 'The orchestrator can choose this worker for a task.'}
        accessory={<SettingsToggleButton checked={selected} disabled={disabled}
          activeLabel={`Allow ${item.label} workers`} inactiveLabel={`Allow ${item.label} workers`}
          onChange={enabled => onChange(enabled ? [...pool, item.id] : pool.filter(id => id !== item.id))} />}
        disabled={disabled} divider />;
    })}
  </>;
}
