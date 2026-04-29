'use client';

import { useState } from 'react';
import { Key } from '../lucide-shims';
import { GlassButton } from './atoms';
import {
  THEME_ACCENT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_SOFT,
  THEME_DIVIDER,
  THEME_GLASS_MUTED,
  THEME_GLASS_MUTED_STRONG,
  THEME_PANEL_BORDER,
  THEME_SEARCH_BG,
  THEME_SEARCH_BORDER,
  THEME_TEXT,
  THEME_TEXT_MUTED,
} from './theme';

// v1: Only OpenRouter is exposed in the wizard. The o8 Operator uses Gemini
// under the hood via GOOGLE_AI_API_KEY which is provisioned silently.
// `/api/v2/keys` is the single source of truth — keys are AES-256-GCM
// encrypted and written to ~/.o8/.env.local where the LLM subsystem reads them.
export function ApiKeyInput({ onSave }: { onSave?: (provider: string) => void }) {
  const [provider, setProvider] = useState('openrouter');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providers = [
    { id: 'openrouter', name: 'OpenRouter', prefix: 'sk-or-' },
  ];

  const current = providers.find((p) => p.id === provider)!;

  const handleSave = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/v2/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: current.id, key: trimmed }),
      });
      const body = await res.json().catch(() => null) as { error?: string; warning?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? `Save failed (${res.status})`);
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSave?.(current.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      padding: '14px 16px',
      borderRadius: 14,
      background: THEME_GLASS_MUTED_STRONG,
      border: `1px solid ${THEME_PANEL_BORDER}`,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: THEME_ACCENT }}><Key size={16} strokeWidth={2} /></span>
        <span style={{ fontSize: 13, fontWeight: 700, color: THEME_TEXT }}>API Key</span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {providers.map((p) => (
          <button
            key={p.id}
            onClick={() => setProvider(p.id)}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: provider === p.id
                ? `1px solid ${THEME_ACCENT_BORDER}`
                : `1px solid ${THEME_DIVIDER}`,
              background: provider === p.id ? THEME_ACCENT_SOFT : THEME_GLASS_MUTED,
              color: provider === p.id ? THEME_ACCENT : THEME_TEXT_MUTED,
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {p.name}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="password"
          placeholder={`${current.prefix}...`}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          style={{
            flex: 1,
            padding: '8px 10px',
            borderRadius: 8,
            border: `1px solid ${THEME_SEARCH_BORDER}`,
            background: THEME_SEARCH_BG,
            fontSize: 12,
            fontFamily: '"SF Mono", ui-monospace, monospace',
            color: THEME_TEXT,
            outline: 'none',
          }}
        />
        <GlassButton
          label={saved ? 'Saved' : saving ? 'Saving' : 'Save'}
          variant="secondary"
          onClick={handleSave}
          disabled={saving || !apiKey.trim()}
          style={{ padding: '8px 16px', fontSize: 12 }}
        />
      </div>
      {error ? (
        <div style={{ fontSize: 11, color: '#ef4444', lineHeight: 1.4 }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
