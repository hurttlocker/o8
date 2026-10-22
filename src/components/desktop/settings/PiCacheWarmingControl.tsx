'use client';

import { useState } from 'react';
import { SettingsSegmented } from './shared';
import type { PiUserSetup } from '@/lib/pi/user-setup';
import type { PiCacheWarming } from '@/lib/pi/cache-warming';

const OPTIONS: Array<{ value: PiCacheWarming; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'streaming', label: 'During runs' },
  { value: 'idle', label: 'During and between runs' },
];

export function PiCacheWarmingControl({ setup, onSaved }: { setup: PiUserSetup; onSaved: () => void }) {
  const [mode, setMode] = useState(setup.cacheWarming ?? 'streaming');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(next: PiCacheWarming) {
    if (saving || next === mode) return;
    setSaving(true); setError(null);
    try {
      const response = await fetch('/api/setup/pi/cache-warming', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cacheWarming: next }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Pi settings could not be saved. Retry the change.');
      setMode(next); onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Pi settings could not be saved. Retry the change.');
    } finally { setSaving(false); }
  }
  return <div style={{ marginTop: 8 }}>
    <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', marginBottom: 8 }}>
      {setup.cacheWarmingSupported
        ? 'Cache warming: this setting changes Pi everywhere, including runs outside o8.'
        : 'Update Pi to 0.86.0 or newer to use cache warming.'}
    </div>
    {setup.cacheWarmingSupported ? <fieldset disabled={saving} aria-label="Pi cache warming"
      style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <SettingsSegmented value={mode} onChange={next => { void save(next as PiCacheWarming); }} options={OPTIONS} />
    </fieldset> : null}
    {saving ? <div role="status" style={{ fontSize: 12, marginTop: 6 }}>Saving…</div> : null}
    {error ? <div role="alert" style={{ fontSize: 12, color: 'var(--t-text-secondary)', marginTop: 6 }}>{error}</div> : null}
  </div>;
}
