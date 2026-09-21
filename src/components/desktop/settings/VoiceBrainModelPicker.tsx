'use client';

import { useState } from 'react';
import { AcpModelPickerPopover } from './AcpModelPickerPopover';
import { SettingsSelect } from './shared';
import { VOICE_BRAIN_MODELS } from './voice-brain-models';

export function VoiceBrainModelPicker({ provider, value, onChange }: {
  provider: string | null;
  value: string | null;
  onChange: (model: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const models = provider ? VOICE_BRAIN_MODELS[provider] ?? [] : [];
  const selected = value ?? '';
  const options = [{ value: '', label: 'Automatic — use seat default' }, ...models];
  if (selected && !models.some((model) => model.value === selected)) {
    options.push({ value: selected, label: `Saved override: ${selected}` });
  }

  async function save(model: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onChange(model);
    } catch {
      setError('Could not save the model. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 280 }}>
      {provider === 'opencode' ? (
        <AcpModelPickerPopover
          backend="opencode"
          label={selected || 'Automatic — runtime default'}
          value={selected || null}
          onSelect={(model) => { void save(model); }}
          onClear={() => { void save(''); }}
          disabled={busy}
        />
      ) : (
        <label>
          <span style={{ display: 'block', fontSize: 11, color: 'var(--t-text-secondary)', marginBottom: 4 }}>Background model</span>
          <SettingsSelect
            value={selected}
            options={options}
            onChange={(model) => { void save(model); }}
            disabled={busy || !provider || models.length === 0}
            width={220}
          />
        </label>
      )}
      {error ? <span role="alert" style={{ fontSize: 12, color: 'var(--t-text)' }}>{error}</span> : null}
    </div>
  );
}
