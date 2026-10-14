'use client';

import { useCallback, useEffect, useState } from 'react';
import { BracketLabel, RamsButton } from './shared';
import { OpenRouterModelsSection } from './OpenRouterModelsSection';

type ConnectionState = 'disconnected' | 'configured-unverified' | 'connected' | 'degraded' | 'disabled';

export interface OpenRouterConnectionView {
  state: ConnectionState;
  enabled: boolean;
  checkedAt: string | null;
  lastError: string | null;
  details: {
    limit: number | null;
    limitRemaining: number | null;
    usageDaily: number | null;
    usageMonthly: number | null;
    isFreeTier: boolean | null;
    expiresAt: string | null;
  } | null;
}

const STATE_LABEL: Record<ConnectionState, string> = {
  disconnected: 'not connected',
  'configured-unverified': 'saved, not verified',
  connected: 'connected',
  degraded: 'check failed',
  disabled: 'off',
};

const money = (value: number | null | undefined) => typeof value === 'number' ? `$${value.toFixed(value < 1 ? 4 : 2)}` : null;

function checkedLabel(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : `Checked ${at.toLocaleString()}`;
}

/** Reads and controls the OpenRouter connection (#3583). It never receives the key. */
export function useOpenRouterConnection() {
  const [connection, setConnection] = useState<OpenRouterConnectionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/v2/keys', { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not read the OpenRouter connection.');
      const payload = await response.json() as { providers?: Array<{ id: string; connection?: OpenRouterConnectionView }> };
      setConnection(payload.providers?.find(provider => provider.id === 'openrouter')?.connection ?? null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read the OpenRouter connection.');
    }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => { void load(); };
    window.addEventListener('o8:openrouter-connection-changed', refresh);
    return () => window.removeEventListener('o8:openrouter-connection-changed', refresh);
  }, [load]);
  return { connection, error, setConnection, setError, reload: load };
}

export function OpenRouterConnectionCard({ state }: { state: ReturnType<typeof useOpenRouterConnection> }) {
  const { connection, error, setConnection, setError } = state;
  const [busy, setBusy] = useState<'check' | 'toggle' | null>(null);

  const send = async (kind: 'check' | 'toggle', body: Record<string, unknown>) => {
    setBusy(kind);
    try {
      const response = await fetch('/api/v2/keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'openrouter', ...body }),
      });
      const payload = await response.json().catch(() => ({})) as { connection?: OpenRouterConnectionView; error?: string };
      if (!response.ok || !payload.connection) throw new Error(payload.error || 'The OpenRouter connection did not change.');
      setConnection(payload.connection);
      setError(null);
      window.dispatchEvent(new Event('o8:openrouter-connection-changed'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The OpenRouter connection did not change.');
    } finally {
      setBusy(null);
    }
  };

  if (!connection) {
    return error ? <p role="alert" style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>{error}</p> : null;
  }

  const figures = connection.state === 'disabled' ? [] : [
    connection.details?.usageDaily != null ? `Today ${money(connection.details.usageDaily)}` : null,
    connection.details?.usageMonthly != null ? `This month ${money(connection.details.usageMonthly)}` : null,
    connection.details?.limitRemaining != null ? `${money(connection.details.limitRemaining)} left of this key's ${money(connection.details.limit)} limit` : null,
    connection.details?.isFreeTier ? 'Free-tier key' : null,
  ].filter(Boolean);
  const checked = checkedLabel(connection.checkedAt);
  const canCheck = connection.enabled && connection.state !== 'disconnected';

  return <section aria-label="OpenRouter connection" style={{ marginTop: 16, marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 13, color: 'var(--t-text)', fontWeight: 300 }}>Connection</span>
      <BracketLabel tone={connection.state === 'connected' ? 'quiet' : 'accent'}>{STATE_LABEL[connection.state]}</BracketLabel>
      {checked && connection.state !== 'disabled' ? <span style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>{checked}</span> : null}
    </div>
    {connection.state === 'disabled'
      ? <p style={{ margin: 0, fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.55 }}>o8, Symon and voice make no OpenRouter calls while this is off. Your key stays saved.</p>
      : null}
    {figures.length ? <p style={{ margin: 0, fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.55 }}>
      {figures.join(' · ')}. These figures cover this key everywhere, including use outside o8.
    </p> : null}
    {connection.lastError && connection.state !== 'disabled' ? <p role="status" style={{ margin: 0, fontSize: 12, color: 'var(--t-text-secondary)' }}>{connection.lastError}</p> : null}
    {error ? <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--t-text-secondary)' }}>{error}</p> : null}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {canCheck ? <RamsButton variant="ghost" busy={busy === 'check'} disabled={busy !== null} onClick={() => void send('check', { check: true })}>Check now</RamsButton> : null}
      <RamsButton variant="ghost" busy={busy === 'toggle'} disabled={busy !== null} onClick={() => void send('toggle', { enabled: !connection.enabled })}>
        {connection.enabled ? 'Turn off' : 'Turn on'}
      </RamsButton>
    </div>
  </section>;
}

/** OpenRouter extras in Providers: connection controls, and models only while the key is usable. */
export function OpenRouterProviderPanel() {
  const state = useOpenRouterConnection();
  const usable = state.connection && state.connection.state !== 'disabled' && state.connection.state !== 'disconnected';
  return <>
    <OpenRouterConnectionCard state={state} />
    {usable ? <OpenRouterModelsSection /> : null}
  </>;
}
