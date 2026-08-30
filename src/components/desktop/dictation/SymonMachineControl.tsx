'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { isTauri } from '@/lib/tauri/bridge';
import {
  DEFAULT_SYMON_MACHINE,
  parseSymonMachineIdentity,
  type SymonMachineIdentity,
} from '@/lib/symon/machine-registry';
import { SymonCapabilitiesPanel } from './SymonCapabilitiesPanel';

interface ListedMachine extends SymonMachineIdentity {
  available: boolean;
}

/**
 * Minimized state (Q 2026-08-05): the orb can collapse into a thin line in
 * the status bar near the "?" — persisted so it survives reloads, synced
 * across the orb and the status-bar line via a window event.
 */
const ORB_MINIMIZED_KEY = 'o8:symon-orb:minimized';
const ORB_MINIMIZED_EVENT = 'o8:symon-orb-minimized';

export function isSymonOrbMinimized(): boolean {
  try { return window.localStorage.getItem(ORB_MINIMIZED_KEY) === '1'; } catch { return false; }
}

export function setSymonOrbMinimized(minimized: boolean): void {
  try {
    if (minimized) window.localStorage.setItem(ORB_MINIMIZED_KEY, '1');
    else window.localStorage.removeItem(ORB_MINIMIZED_KEY);
  } catch { /* localStorage unavailable — session-only */ }
  window.dispatchEvent(new CustomEvent(ORB_MINIMIZED_EVENT, { detail: { minimized } }));
}

export function useSymonOrbMinimized(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      window.addEventListener(ORB_MINIMIZED_EVENT, onStoreChange);
      return () => window.removeEventListener(ORB_MINIMIZED_EVENT, onStoreChange);
    },
    isSymonOrbMinimized,
    () => false,
  );
}

/**
 * The thin status-bar line the orb collapses into — mounted by
 * DesktopStatusBar beside the "?" button. Renders nothing while the orb is
 * expanded. Click restores the orb to his seat by the composer.
 */
export function SymonOrbStatusLine() {
  const minimized = useSymonOrbMinimized();
  const [hovered, setHovered] = useState(false);
  if (!minimized) return null;
  return (
    <button
      type="button"
      aria-label="Restore Symon"
      title="Symon is minimized — click to restore"
      onClick={() => setSymonOrbMinimized(false)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        borderRadius: 6,
        borderWidth: 0,
        background: hovered ? 'var(--t-hover)' : 'transparent',
        cursor: 'pointer',
        padding: 0,
        transition: 'background 120ms ease',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 14,
          height: 3,
          borderRadius: 999,
          background: 'conic-gradient(from 210deg at 50% 50%, #88d1f1, #b1b4e5 32%, #f5b8c4 62%, #f4c977 82%, #88d1f1)',
          opacity: hovered ? 1 : 0.75,
          transition: 'opacity 120ms ease',
        }}
      />
    </button>
  );
}

export function SymonMachineControl() {
  const [active, setActive] = useState<SymonMachineIdentity>(DEFAULT_SYMON_MACHINE);
  const [machines, setMachines] = useState<ListedMachine[]>([
    { ...DEFAULT_SYMON_MACHINE, available: true },
    { id: 'macbook', displayName: 'MacBook', available: false },
  ]);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'machine' | 'capabilities'>('machine');
  const [rightOffset, setRightOffset] = useState(16);
  const minimized = useSymonOrbMinimized();
  const rootRef = useRef<HTMLDivElement>(null);

  // Track the CENTER pane's right edge (TileContainer's data-o8-workspace
  // root) so the orb keeps his seat beside the composer when the right panel
  // opens/closes/resizes. ResizeObserver catches panel drags; the re-query on
  // each pass survives the pane element being rebuilt across layout changes.
  useEffect(() => {
    let observer: ResizeObserver | null = null;
    let observed: Element | null = null;
    const compute = () => {
      const pane = document.querySelector('[data-o8-workspace="1"]');
      if (pane !== observed && observer) {
        if (observed) observer.unobserve(observed);
        if (pane) observer.observe(pane);
        observed = pane;
      }
      if (!pane) { setRightOffset(16); return; }
      const rect = pane.getBoundingClientRect();
      setRightOffset(Math.max(16, Math.round(window.innerWidth - rect.right) + 16));
    };
    observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(compute) : null;
    compute();
    window.addEventListener('resize', compute);
    const requery = setInterval(compute, 2000);
    return () => {
      window.removeEventListener('resize', compute);
      clearInterval(requery);
      observer?.disconnect();
      observer = null;
    };
  }, []);

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
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setView('machine');
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setView('machine');
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!isTauri()) return null;
  if (minimized) return null;

  return (
    <div
      ref={rootRef}
      style={{
        position: 'fixed',
        bottom: 120,
        // Anchored to the CENTER pane's right edge, not the viewport — with
        // the right panel open, a viewport anchor floated the orb over the
        // panel instead of his usual seat beside the composer (Q 2026-08-05).
        right: rightOffset,
        zIndex: 50,
        transition: 'right 220ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <AnimatePresence>
        {open ? (
          <motion.div
            role="dialog"
            aria-label={view === 'capabilities' ? 'Symon capabilities' : 'Symon machine control'}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            style={{
              position: 'absolute',
              right: 0,
              bottom: 44,
              width: view === 'capabilities' ? 360 : 220,
              paddingTop: 10,
              paddingRight: 11,
              paddingBottom: 10,
              paddingLeft: 11,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: error ? 'var(--t-danger)' : 'var(--t-border)',
              borderRadius: 14,
              background: 'color-mix(in srgb, var(--t-input-bg) 88%, transparent)',
              backdropFilter: 'blur(28px) saturate(1.2)',
              WebkitBackdropFilter: 'blur(28px) saturate(1.2)',
              color: 'var(--t-text)',
              boxShadow: '0 12px 34px rgba(0, 0, 0, 0.2)',
              fontFamily: 'var(--font-sans-system)',
            }}
          >
            {view === 'capabilities' ? (
              <SymonCapabilitiesPanel
                machineDisplayName={active.displayName}
                onBack={() => setView('machine')}
                onStarted={() => { setOpen(false); setView('machine'); }}
              />
            ) : (
              <>
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
                    fontWeight: 300,
                    cursor: switching ? 'wait' : 'pointer',
                  }}
                >
                  {machines.map((machine) => (
                    <option key={machine.id} value={machine.id} disabled={!machine.available && machine.id !== active.id}>
                      {machine.displayName}{machine.available ? '' : ' (offline)'}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label="What Symon can do"
                  onClick={() => setView('capabilities')}
                  onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; event.currentTarget.style.color = 'var(--t-text)'; }}
                  onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; event.currentTarget.style.color = 'var(--t-text-muted)'; }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    width: '100%',
                    minHeight: 44,
                    marginTop: 7,
                    paddingTop: 0,
                    paddingRight: 8,
                    paddingBottom: 0,
                    paddingLeft: 8,
                    borderRadius: 7,
                    borderWidth: 0,
                    background: 'transparent',
                    color: 'var(--t-text-muted)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: 'var(--font-sans-system)',
                    fontSize: 11.5,
                    fontWeight: 300,
                    letterSpacing: '-0.1px',
                    transition: 'background 120ms ease, color 120ms ease',
                  }}
                >
                  What Symon can do
                  <span aria-hidden style={{ marginLeft: 'auto', color: 'var(--t-text-faint)', fontSize: 16 }}>›</span>
                </button>
                <button
                  type="button"
                  aria-label="Minimize Symon to the status bar"
                  onClick={() => { setOpen(false); setSymonOrbMinimized(true); }}
                  onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; event.currentTarget.style.color = 'var(--t-text)'; }}
                  onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; event.currentTarget.style.color = 'var(--t-text-muted)'; }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    width: '100%',
                    minHeight: 24,
                    marginTop: 7,
                    paddingTop: 0,
                    paddingRight: 6,
                    paddingBottom: 0,
                    paddingLeft: 6,
                    borderRadius: 7,
                    borderWidth: 0,
                    background: 'transparent',
                    color: 'var(--t-text-muted)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: 'var(--font-sans-system)',
                    fontSize: 11.5,
                    fontWeight: 300,
                    letterSpacing: '-0.1px',
                    transition: 'background 120ms ease, color 120ms ease',
                  }}
                >
                  <span aria-hidden style={{ display: 'inline-flex', width: 12, height: 2.5, borderRadius: 999, background: 'currentColor', opacity: 0.7, flexShrink: 0 }} />
                  Minimize to status bar
                </button>
              </>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
      <button
        type="button"
        aria-label={`Symon machine: ${active.displayName}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={error || `${active.displayName} has the Symon session`}
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
