'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
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
  const prefersReducedMotion = useReducedMotion();
  const [active, setActive] = useState<SymonMachineIdentity>(DEFAULT_SYMON_MACHINE);
  const [machines, setMachines] = useState<ListedMachine[]>([
    { ...DEFAULT_SYMON_MACHINE, available: true },
    { id: 'macbook', displayName: 'MacBook', available: false },
  ]);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!isTauri()) return null;

  return (
    <div
      ref={rootRef}
      title={error || `${active.displayName} has the Symon session`}
      style={{
        position: 'fixed',
        bottom: 120,
        right: 16,
        zIndex: 50,
      }}
    >
      <AnimatePresence>
        {open ? (
          <motion.div
            role="dialog"
            aria-label="Symon machine control"
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            style={{
              position: 'absolute',
              right: 0,
              bottom: 44,
              width: 188,
              paddingTop: 10,
              paddingRight: 11,
              paddingBottom: 10,
              paddingLeft: 11,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: error ? 'var(--t-danger)' : 'var(--t-border)',
              borderRadius: 14,
              background: 'var(--t-bg-card)',
              color: 'var(--t-text)',
              boxShadow: '0 12px 34px rgba(0, 0, 0, 0.2)',
              transformOrigin: 'bottom right',
              fontFamily: 'var(--font-sans-system)',
            }}
          >
            <div style={{ color: error ? 'var(--t-danger)' : 'var(--t-text-muted)', fontSize: 10, lineHeight: 1.2, marginBottom: 5 }}>
              {error || 'Symon on'}
            </div>
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
                width: '100%',
                borderWidth: 0,
                outline: 0,
                background: 'transparent',
                color: 'var(--t-text)',
                font: 'inherit',
                fontSize: 12,
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
          </motion.div>
        ) : null}
      </AnimatePresence>
      <button
        type="button"
        aria-label={`Symon machine: ${active.displayName}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 34,
          height: 34,
          paddingTop: 0,
          paddingRight: 0,
          paddingBottom: 0,
          paddingLeft: 0,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: error ? 'var(--t-danger)' : 'var(--t-border)',
          borderRadius: 17,
          background: 'var(--t-bg-card)',
          boxShadow: '0 6px 20px rgba(0, 0, 0, 0.16)',
          cursor: 'pointer',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 17,
            height: 17,
            borderRadius: '50%',
            background: 'radial-gradient(circle at 64% 28%, color-mix(in srgb, var(--t-text) 90%, transparent), transparent 30%), conic-gradient(from 210deg at 50% 50%, #88d1f1, #b1b4e5 32%, #f5b8c4 62%, #f4c977 82%, #88d1f1)',
            boxShadow: error ? '0 0 0 2px var(--t-danger)' : '0 0 9px rgba(136, 209, 241, 0.45)',
          }}
        />
      </button>
    </div>
  );
}
