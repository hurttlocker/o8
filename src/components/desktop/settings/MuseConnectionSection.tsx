'use client';

import { useEffect, useRef, useState } from 'react';
import { RamsButton } from './shared';
import { SettingsGroup, SettingsRow } from './grouped';

export function MuseConnectionSection() {
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState('');
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const check = async () => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    setChecking(true); setNotice('Reading the Muse model catalog…');
    try {
      const response = await fetch('/api/orchestrator/backend-models?backend=muse&refresh=1', { signal: controller.signal, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error('Models could not be checked. Sign in through Muse Code, then retry.');
      if (!data.available) throw new Error('Install Muse Code, then check again.');
      const rows = Array.isArray(data.groups) ? data.groups.flatMap((group: { models?: unknown }) => Array.isArray(group.models) ? group.models : []) : [];
      if (!controller.signal.aborted) {
        setModels(rows.filter((model: { id?: unknown; label?: unknown }) => typeof model.id === 'string' && typeof model.label === 'string'));
        setNotice(rows.length ? `${rows.length} models reported. Account access is checked when work starts.` : 'No models reported. Sign in through Muse Code, then check again.');
      }
    } catch (error) {
      if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : 'Could not check Muse.');
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setChecking(false);
    }
  };

  return <SettingsGroup header="Muse connection">
    <SettingsRow label="Sign in" subtitle="Open Muse Code in a terminal. Use /login to connect its account." accessory={
      <a href="https://dev.meta.ai/docs/muse-code" target="_blank" rel="noreferrer" style={{ color: 'var(--t-accent)', fontSize: 12 }}>Setup guide</a>
    } divider />
    <SettingsRow label="Models" subtitle="Choose Muse Code in the composer or worker picker. Wonder Full requires an eligible Muse Code plan." accessory={
      <RamsButton variant="ghost" busy={checking} disabled={checking} onClick={() => void check()}>Check models</RamsButton>
    } divider />
    {notice ? <div role="status" style={{ padding: 12, fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>{notice}</div> : null}
    {models.length ? <div style={{ maxHeight: 200, overflowY: 'auto', padding: 12, display: 'grid', gap: 6, fontSize: 12 }}>
      {models.map(model => <span key={model.id} title={model.id}>{model.label}</span>)}
    </div> : null}
    <SettingsRow label="Usage" subtitle="Uses your Muse Code configuration. Remaining account capacity is not reported here." />
  </SettingsGroup>;
}
