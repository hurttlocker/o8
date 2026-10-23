'use client';

import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { RamsButton } from './settings/RamsButton';

const inputStyle: CSSProperties = {
  minHeight: 32, paddingTop: 6, paddingRight: 12, paddingBottom: 6, paddingLeft: 12,
  border: '1px solid var(--t-border)', borderRadius: 8, background: 'var(--t-input-bg)',
  color: 'var(--t-text)', fontFamily: 'inherit', fontSize: 12, fontWeight: 300, cursor: 'pointer',
};

/** Optional, explicit consent. The address stays in this form until submitted. */
export function ReleaseNotesSignup({ request = fetch }: { request?: typeof fetch }) {
  const id = useId();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');
  const [waiting, setWaiting] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {
    pending.current?.abort(); pending.current = null; clearTimeout(timer.current);
  }, []);
  useEffect(() => {
    if (state !== 'busy') return;
    const stage = setTimeout(() => setWaiting(true), 3_000);
    return () => clearTimeout(stage);
  }, [state]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current || state === 'done') return;
    const value = email.trim();
    if (value.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      setError('Enter a valid email address.'); setState('error'); return;
    }
    const controller = new AbortController();
    pending.current = controller;
    timer.current = setTimeout(() => controller.abort(), 15_000);
    setState('busy'); setWaiting(false); setError('');
    try {
      const response = await request('/api/panel/release-notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: value }), credentials: 'omit', signal: controller.signal,
      });
      const result = await response.json().catch(() => null) as { ok?: unknown; error?: unknown; reason?: unknown } | null;
      if (pending.current !== controller) return;
      if (response.ok && result?.ok === true) { setState('done'); setEmail(''); }
      else {
        setState('error');
        setError(response.status === 503 || result?.reason === 'not_configured'
          ? 'Signups are paused. Please try again later.' : 'Could not subscribe. Please try again.');
      }
    } catch {
      if (pending.current === controller) { setState('error'); setError('Could not subscribe. Please try again.'); }
    } finally {
      if (pending.current === controller) { pending.current = null; clearTimeout(timer.current); }
    }
  };

  return <section aria-label="Release notes by email" style={{ fontSize: 12, fontWeight: 300, color: 'var(--t-text)', width: '100%' }}>
    {state === 'done' ? <p role="status" style={{ margin: 0 }}>You’re subscribed to release notes.</p> : <form onSubmit={(event) => void submit(event)}>
      <label htmlFor={id} style={{ display: 'block' }}>Get release notes by email <span style={{ color: 'var(--t-text-muted)' }}>(optional)</span></label>
      <p id={`${id}-consent`} style={{ marginTop: 6, marginBottom: 10, fontSize: 11, color: 'var(--t-text-muted)' }}>Weekly release notes. Unsubscribe anytime.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <input id={id} type="email" required maxLength={254} autoComplete="email" aria-label="Email for o8 release notes" aria-describedby={`${id}-consent${error ? ` ${id}-error` : ''}`} aria-invalid={state === 'error' || undefined}
          value={email} disabled={state === 'busy'} onChange={(event) => { setEmail(event.target.value); setError(''); setState('idle'); }}
          style={{ ...inputStyle, flex: '1 1 180px', minWidth: 0, cursor: 'text' }} />
        <RamsButton type="submit" variant="ghost" busy={state === 'busy'}>{state === 'busy' ? waiting ? 'Waiting for confirmation…' : 'Subscribing…' : 'Subscribe'}</RamsButton>
      </div>
      {error ? <p id={`${id}-error`} role="alert" style={{ marginTop: 8, marginBottom: 0, color: 'var(--t-danger)', fontSize: 11 }}>{error}</p> : null}
    </form>}
    <a href="https://discord.gg/TFK2x9A5WS" target="_blank" rel="noopener noreferrer" onClick={(event) => { event.preventDefault(); void openExternalUrl(event.currentTarget.href); }}
      style={{ display: 'inline-block', marginTop: 10, color: 'var(--t-text-muted)', fontSize: 11 }}>Join the community on Discord</a>
  </section>;
}
