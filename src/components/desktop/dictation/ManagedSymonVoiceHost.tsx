'use client';
import { useEffect, useRef, useState } from 'react';
import { getManagedSymonBackend, subscribeManagedSymonConfirmation, type ManagedSymonConfirmation } from '@/lib/voice/managed-live/symon-backend';
import { startManagedLive, type LiveSession, type LiveState } from '@/lib/voice/managed-live/session';

export function ManagedSymonVoiceHost() {
  const [state, setState] = useState<LiveState>('idle');
  const [detail, setDetail] = useState('');
  useEffect(() => { window.dispatchEvent(new CustomEvent('o8:managed-symon-status', { detail: state })); }, [state]);
  const [confirmation, setConfirmation] = useState<ManagedSymonConfirmation | null>(null);
  useEffect(() => subscribeManagedSymonConfirmation(setConfirmation), []);
  const session = useRef<LiveSession | null>(null);
  const starting = useRef(false);
  const startup = useRef<AbortController | null>(null);
  useEffect(() => {
    let alive = true;
    const toggle = async () => {
      if (starting.current) { startup.current?.abort(); setState('closing'); return; }
      if (session.current && ['live', 'connecting', 'closing'].includes(session.current.state)) {
        await session.current.close(); return;
      }
      starting.current = true; setState('connecting');
      const controller = new AbortController(); startup.current = controller;
      try {
        const backend = await getManagedSymonBackend();
        const live = await startManagedLive(backend, (next, message) => {
          if (alive) { setState(next); setDetail(message ?? ''); }
        }, controller.signal);
        if (!alive) await live.close(); else session.current = live;
      } catch (error) {
        if (alive) { setState('error'); setDetail(error instanceof Error ? error.message : 'Symon voice unavailable.'); }
      } finally { starting.current = false; }
    };
    const listener = () => { void toggle(); };
    window.addEventListener('o8:managed-symon-toggle', listener);
    return () => { alive = false; startup.current?.abort(); window.removeEventListener('o8:managed-symon-toggle', listener); void session.current?.close(); };
  }, []);
  if ((state === 'idle' || state === 'closed') && !confirmation) return null;
  return <><div role="status" style={{ position: 'fixed', bottom: 70, right: 24, zIndex: 1000,
    background: 'var(--t-bg-card)', color: 'var(--t-text)', maxWidth: 420 }}>
    {confirmation ? <><p>{confirmation.tool}: {confirmation.summary}</p>
      {confirmation.steps.map((step, index) => <p key={index}>{index + 1}. {step}</p>)}
      <button type="button" onClick={() => confirmation.decide(false)}>Decline</button>
      <button type="button" onClick={() => confirmation.decide(true)}>Approve this action</button></> : null}
  </div><button type="button" onClick={() => { startup.current?.abort(); void session.current?.close(); }}
    title={detail || 'Disconnect voice. Backend tasks and context remain active.'}
    style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 1000, background: 'var(--t-bg-card)', color: 'var(--t-text)',
      border: '1px solid var(--t-border)', borderRadius: 8, paddingTop: 6, paddingBottom: 6, paddingLeft: 12, paddingRight: 12, fontSize: 11, fontWeight: 300 }}>
    Symon voice: {state}{detail ? ` · ${detail}` : ''}
  </button></>;
}
