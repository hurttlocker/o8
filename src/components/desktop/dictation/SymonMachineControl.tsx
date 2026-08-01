'use client';

import { useEffect, useState } from 'react';
import { isTauri } from '@/lib/tauri/bridge';
import {
  DEFAULT_SYMON_MACHINE,
  parseSymonMachineIdentity,
  type SymonMachineIdentity,
} from '@/lib/symon/machine-registry';

interface ListedMachine extends SymonMachineIdentity {
  available: boolean;
}

export function SymonMachineControl() {
  const [active, setActive] = useState<SymonMachineIdentity>(DEFAULT_SYMON_MACHINE);
  const [machines, setMachines] = useState<ListedMachine[]>([
    { ...DEFAULT_SYMON_MACHINE, available: true },
    { id: 'macbook', displayName: 'MacBook', available: false },
  ]);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    void Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event'),
    ]).then(async ([{ invoke }, { listen }]) => {
      const [status, list] = await Promise.all([
        invoke<unknown>('symon_machine_status', { sessionId: 'desktop' }),
        invoke<{ machines?: unknown[] }>('symon_machine_list', { sessionId: 'desktop' }),
      ]);
      if (!alive) return;
      const parsedStatus = parseSymonMachineIdentity(status);
      if (parsedStatus) setActive(parsedStatus);
      const parsedMachines = (list.machines ?? []).flatMap((value) => {
        const identity = parseSymonMachineIdentity(value);
        if (!identity || !value || typeof value !== 'object') return [];
        return [{ ...identity, available: (value as Record<string, unknown>).available === true }];
      });
      if (parsedMachines.length > 0) setMachines(parsedMachines);
      unlisten = await listen<unknown>('o8:symon-machine', (event) => {
        const identity = parseSymonMachineIdentity(event.payload);
        if (identity) setActive(identity);
      });
    }).catch((reason) => {
      if (alive) setError(reason instanceof Error ? reason.message : 'Machine status unavailable');
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  if (!isTauri()) return null;

  return (
    <div
      title={error || `${active.displayName} has the Symon session`}
      style={{
        position: 'fixed',
        top: 12,
        right: 16,
        zIndex: 2147483646,
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        paddingTop: 5,
        paddingBottom: 5,
        paddingLeft: 10,
        paddingRight: 10,
        border: `1px solid ${error ? 'var(--t-danger)' : 'var(--t-border)'}`,
        borderRadius: 999,
        background: 'var(--t-bg-card)',
        color: 'var(--t-text)',
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.14)',
        fontSize: 12,
      }}
    >
      <span style={{ color: error ? 'var(--t-danger)' : 'var(--t-text-muted)' }}>Symon on</span>
      <select
        aria-label="Active Symon machine"
        value={active.id}
        disabled={switching}
        onChange={(event) => {
          const machineId = event.target.value;
          setSwitching(true);
          setError('');
          void import('@tauri-apps/api/core')
            .then(({ invoke }) => invoke<unknown>('symon_machine_switch', {
              sessionId: 'desktop',
              machineId,
            }))
            .then((value) => {
              const identity = parseSymonMachineIdentity(value);
              if (identity) setActive(identity);
            })
            .catch((reason) => setError(reason instanceof Error ? reason.message : 'Machine switch refused'))
            .finally(() => setSwitching(false));
        }}
        style={{
          border: 0,
          outline: 0,
          background: 'transparent',
          color: 'var(--t-text)',
          font: 'inherit',
          fontWeight: 600,
          cursor: switching ? 'wait' : 'pointer',
        }}
      >
        {machines.map((machine) => (
          <option key={machine.id} value={machine.id} disabled={!machine.available && machine.id !== active.id}>
            {machine.displayName}{machine.available ? '' : ' (offline)'}
          </option>
        ))}
      </select>
    </div>
  );
}
