'use client';

import { useEffect, useRef, useState } from 'react';
import type { SymonTextBrainMode } from '@/lib/symon/durable/text-brain-setting';
import { SettingsGroup } from './grouped';
import { RamsButton, SettingsSelect } from './shared';

const OPTIONS = [
  { value: 'auto', label: 'Automatic' },
  { value: 'pi', label: 'o8 managed' },
  { value: 'planner', label: 'Connected planner' },
];

function validMode(value: unknown): value is SymonTextBrainMode {
  return OPTIONS.some((option) => option.value === value);
}

export function SymonTextBrainSection() {
  const [mode, setMode] = useState<SymonTextBrainMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  async function request(next?: string) {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/panel/symon/text-brain', {
        cache: 'no-store', signal,
        ...(next ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: next }) } : {}),
      });
      const data = await response.json() as { ok?: boolean; mode?: unknown };
      if (!response.ok || !data.ok || !validMode(data.mode)) throw new Error();
      if (!signal.aborted) setMode(data.mode);
    } catch {
      if (!signal.aborted) {
        if (next) setMode(null);
        setError(next ? 'Could not confirm the text brain. Refresh its saved choice before trying again.' : 'Text brain settings are unavailable.');
      }
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }

  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    void request();
    return () => active.abort();
  }, []);

  return (
    <section style={{ marginTop: 28, marginBottom: 28 }}>
      <SettingsGroup header="Symon text brain" footnote="Automatic uses a connected planner when available, with o8 managed as a fallback. This choice applies to new text turns and preserves saved conversation history.">
        <div style={{ paddingTop: 14, paddingRight: 14, paddingBottom: 14, paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, fontSize: 13.5, fontWeight: 300, color: 'var(--t-text)' }}>
            Text brain
            <SettingsSelect value={mode ?? 'auto'} options={OPTIONS} disabled={busy || mode === null} onChange={(next) => { void request(next); }} />
          </label>
          <p role={error ? 'alert' : 'status'} style={{ margin: 0, color: 'var(--t-text-muted)', fontSize: 12, lineHeight: 1.5 }}>
            {error ?? (busy ? mode ? 'Saving text brain…' : 'Reading text brain…' : 'Saved. No new conversation starts when you change this setting.')}
          </p>
          {error ? <RamsButton variant="ghost" disabled={busy} onClick={() => { void request(); }}>Retry</RamsButton> : null}
        </div>
      </SettingsGroup>
    </section>
  );
}
