'use client';
import { useEffect, useState } from 'react';
import { PickerMenu } from './dispatch-shared';
import { SettingsRow } from './grouped';

type BillingMode = 'subscription' | 'api';
export function RuntimeBillingRow({ runtimeId }: { runtimeId: string }) {
  const [mode, setMode] = useState<BillingMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setMode(null); setError(null);
    void fetch(`/api/runtime/billing?runtimeId=${encodeURIComponent(runtimeId)}`, { cache: 'no-store' })
      .then(async response => { const body = await response.json(); if (!response.ok || !body.ok) throw new Error(body.error ?? 'Could not read billing mode.'); return body.mode as BillingMode; })
      .then(value => { if (active) setMode(value); }).catch(cause => { if (active) setError(String(cause.message ?? cause)); });
    return () => { active = false; };
  }, [runtimeId]);
  const save = async (value: BillingMode) => {
    setBusy(true); setError(null);
    try {
      const response = await fetch('/api/runtime/billing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runtimeId, mode: value }) });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? 'Could not save billing mode.');
      setMode(body.mode);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  if (runtimeId === 'codex') return <SettingsRow label="Who pays" subtitle={<>API billing for Codex is not available yet. <a href="https://github.com/hurttlocker/o8/issues/4334" target="_blank" rel="noreferrer" style={{ color: 'var(--t-text)' }}>Track #4334</a></>} accessory={<span style={{ color: 'var(--t-text-muted)' }}>CLI subscription</span>} divider />;
  return <>
    <SettingsRow label="Who pays" subtitle={mode === 'api' ? 'Your API account pays when this runtime uses a saved key. Applies to new launches.' : 'Your CLI account or subscription pays. o8 does not send saved API keys. Applies to new launches.'}
      accessory={<PickerMenu<BillingMode> value={mode ?? 'subscription'} options={[{ value: 'subscription', label: 'CLI subscription' }, { value: 'api', label: 'My API key' }]} disabled={busy || mode === null} onChange={value => { void save(value); }} minWidth={150} />} divider />
    {error ? <p role="alert" style={{ margin: 0, color: 'var(--t-text)' }}>{error}</p> : null}
  </>;
}
