'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Machine { id: string; label: string; target: string; enabled: boolean }
interface Session { id: string; cols?: number; rows?: number }

async function readResponse<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || 'The saved machine request failed.');
  return payload;
}

export function SavedMachinePicker({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selected, setSelected] = useState<Machine | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [busy, setBusy] = useState<'machines' | 'sessions' | 'opening' | null>('machines');
  const [waitStage, setWaitStage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const firstButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);
  const openRequestRef = useRef(0);
  const openingRef = useRef(false);
  const selectedRef = useRef<Machine | null>(null);
  const closePicker = useCallback(() => {
    requestRef.current += 1;
    openRequestRef.current += 1;
    openingRef.current = false;
    onClose();
  }, [onClose]);

  const refreshMachines = useCallback(async () => {
    const request = ++requestRef.current;
    setBusy('machines');
    setError(null);
    try {
      const payload = await readResponse<{ machines: Machine[] }>(await fetch('/api/panel/ssh-machines', { cache: 'no-store' }));
      if (request !== requestRef.current) return;
      setMachines(payload.machines);
      const machine = payload.machines.find((item) => item.id === selectedRef.current?.id) ?? null;
      selectedRef.current = machine;
      setSelected(machine);
      setSessions([]);
      if (machine?.enabled) {
        setBusy('sessions');
        const inventory = await readResponse<{ sessions: Session[] }>(await fetch(`/api/panel/ssh-machines?machine=${encodeURIComponent(machine.id)}`, { cache: 'no-store' }));
        if (request === requestRef.current) setSessions(inventory.sessions);
      }
    } catch (cause) {
      if (request === requestRef.current) setError(cause instanceof Error ? cause.message : 'Could not load saved machines.');
    } finally {
      if (request === requestRef.current) setBusy(null);
    }
  }, []);

  const selectMachine = useCallback(async (machine: Machine) => {
    const request = ++requestRef.current;
    selectedRef.current = machine;
    setSelected(machine);
    setSessions([]);
    setError(null);
    if (!machine.enabled) {
      setBusy(null);
      return;
    }
    setBusy('sessions');
    try {
      const payload = await readResponse<{ sessions: Session[] }>(await fetch(`/api/panel/ssh-machines?machine=${encodeURIComponent(machine.id)}`, { cache: 'no-store' }));
      if (request === requestRef.current) setSessions(payload.sessions);
    } catch (cause) {
      if (request === requestRef.current) setError(cause instanceof Error ? cause.message : 'Could not reach this machine.');
    } finally {
      if (request === requestRef.current) setBusy(null);
    }
  }, []);

  const openSession = useCallback(async (session: Session) => {
    if (!selected || openingRef.current) return;
    const request = ++openRequestRef.current;
    openingRef.current = true;
    setBusy('opening');
    setError(null);
    try {
      const payload = await readResponse<{ command: string; machine: { id: string; label: string }; sessionId: string }>(await fetch('/api/panel/ssh-machines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: selected.id, sessionId: session.id }),
      }));
      if (request !== openRequestRef.current) return;
      window.dispatchEvent(new CustomEvent('o8:request-open-remote-terminal', {
        detail: { workspaceId, command: payload.command, machineId: payload.machine.id, machineLabel: payload.machine.label, sessionId: payload.sessionId },
      }));
      closePicker();
    } catch (cause) {
      if (request !== openRequestRef.current) return;
      setError(cause instanceof Error ? cause.message : 'Could not open this terminal.');
      setBusy(null);
      openingRef.current = false;
    }
  }, [closePicker, selected, workspaceId]);

  useEffect(() => { void refreshMachines(); }, [refreshMachines]);
  useEffect(() => () => {
    requestRef.current += 1;
    openRequestRef.current += 1;
    openingRef.current = false;
  }, []);
  useEffect(() => { firstButtonRef.current?.focus(); }, []);
  useEffect(() => {
    setWaitStage(0);
    if (busy !== 'sessions' && busy !== 'opening') return;
    const checking = window.setTimeout(() => setWaitStage(1), 3_000);
    const waiting = window.setTimeout(() => setWaitStage(2), 8_000);
    return () => { window.clearTimeout(checking); window.clearTimeout(waiting); };
  }, [busy]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { closePicker(); return; }
      if (event.key !== 'Tab') return;
      const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
      if (buttons.length === 0) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closePicker]);

  return createPortal(
    <div
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) closePicker(); }}
      style={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, zIndex: 150, display: 'flex', justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0, 0, 0, 0.38)' }}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Saved machines" data-no-drag style={{ width: 'min(620px, calc(100vw - 32px))', maxHeight: 'min(680px, calc(100vh - 40px))', overflow: 'auto', scrollbarWidth: 'none', borderRadius: 14, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider)', backgroundColor: 'var(--t-popover-surface)', boxShadow: '0 18px 60px rgba(0, 0, 0, 0.3)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 18, paddingBottom: 12, paddingLeft: 20, paddingRight: 20, borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: 'var(--t-divider)' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 300 }}>Saved machines</div>
            <div style={{ fontSize: 12, color: 'var(--t-text-muted)', marginTop: 4 }}>Open an existing terminal on a trusted SSH host.</div>
          </div>
          <button ref={firstButtonRef} type="button" onClick={closePicker} aria-label="Close saved machines" style={{ borderWidth: 0, backgroundColor: 'transparent', color: 'var(--t-text-secondary)', cursor: 'pointer', paddingTop: 8, paddingBottom: 8, paddingLeft: 8, paddingRight: 8 }}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 0.85fr) minmax(0, 1.15fr)', minHeight: 260 }}>
          <div style={{ borderRightWidth: 1, borderRightStyle: 'solid', borderRightColor: 'var(--t-divider)', paddingTop: 10, paddingBottom: 10, paddingLeft: 10, paddingRight: 10 }}>
            {machines.map((machine) => (
              <button key={machine.id} type="button" disabled={busy === 'opening'} onClick={() => { void selectMachine(machine); }} style={{ display: 'block', width: '100%', textAlign: 'left', paddingTop: 10, paddingBottom: 10, paddingLeft: 11, paddingRight: 11, marginBottom: 3, borderWidth: 0, borderRadius: 8, backgroundColor: selected?.id === machine.id ? 'var(--t-hover)' : 'transparent', color: 'var(--t-text)', cursor: busy === 'opening' ? 'default' : 'pointer' }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 300 }}>{machine.label}</span>
                <span style={{ display: 'block', fontSize: 11, color: 'var(--t-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{machine.enabled ? machine.target : 'Disabled'}</span>
              </button>
            ))}
            {machines.length === 0 && busy !== 'machines' ? <div style={{ paddingTop: 11, paddingBottom: 11, paddingLeft: 11, paddingRight: 11, color: 'var(--t-text-muted)', fontSize: 12 }}>No saved machines. Add one with <code>o8 machine add</code>.</div> : null}
          </div>
          <div style={{ paddingTop: 14, paddingBottom: 14, paddingLeft: 14, paddingRight: 14 }}>
            {!selected ? <div style={{ color: 'var(--t-text-muted)', fontSize: 12 }}>Select a machine to see its terminals.</div> : null}
            {selected && !selected.enabled ? <div style={{ color: 'var(--t-text-muted)', fontSize: 12 }}>This machine is disabled.</div> : null}
            {selected?.enabled && sessions.map((session) => (
              <button key={session.id} type="button" disabled={busy !== null || error !== null} onClick={() => { void openSession(session); }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', textAlign: 'left', paddingTop: 10, paddingBottom: 10, paddingLeft: 12, paddingRight: 12, marginBottom: 5, borderRadius: 8, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider)', backgroundColor: 'transparent', color: 'var(--t-text)', cursor: busy || error ? 'default' : 'pointer', opacity: busy || error ? 0.55 : 1 }}>
                <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.id}</span>
                <span style={{ fontSize: 11, color: 'var(--t-text-muted)', marginLeft: 8 }}>Open</span>
              </button>
            ))}
            {selected?.enabled && sessions.length === 0 && busy === null && !error ? <div style={{ color: 'var(--t-text-muted)', fontSize: 12 }}>No running terminals on this machine.</div> : null}
            {busy ? <div role="status" style={{ color: 'var(--t-text-muted)', fontSize: 12 }}>{busy === 'machines'
              ? 'Loading machines…'
              : busy === 'sessions'
                ? waitStage === 0 ? 'Connecting to machine…' : waitStage === 1 ? 'Checking SSH access and remote o8…' : 'Waiting for terminal inventory…'
                : waitStage === 0 ? 'Opening terminal…' : waitStage === 1 ? 'Checking the session is still available…' : 'Waiting for remote confirmation…'}</div> : null}
            {error ? <div role="alert" style={{ color: 'var(--t-error, #ef4444)', fontSize: 12 }}>{error}</div> : null}
          </div>
        </div>
        <div style={{ borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--t-divider)', display: 'flex', justifyContent: 'flex-end', paddingTop: 10, paddingBottom: 10, paddingLeft: 20, paddingRight: 20 }}>
          <button type="button" onClick={() => { void refreshMachines(); }} disabled={busy !== null} style={{ borderWidth: 0, backgroundColor: 'transparent', color: 'var(--t-text-secondary)', cursor: busy ? 'default' : 'pointer', fontSize: 12 }}>Refresh</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
