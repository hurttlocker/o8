'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  APP_FONT_STACK,
  ActivityIcon,
  KeyIcon,
  PlugIcon,
  THEME_ACCENT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_SOFT,
} from './shared';

type FleetStatusKind = 'running' | 'completed' | 'failed' | 'cancelled';
type RemoteFlagSource = 'env' | 'file' | 'off';

interface WorkerTokenSummary {
  id: string;
  label: string | null;
  scope: string;
  maxWorkers: number;
  createdAt: string;
  revokedAt: string | null;
}

interface FleetTokenSummary {
  tokenId: string;
  label: string | null;
  totalRuns: number;
  lastRunAt: string;
  hasActiveRuns: boolean;
  counts: Record<FleetStatusKind, number>;
}

interface WorkersResponse {
  tokens: WorkerTokenSummary[];
  fleet: {
    counts: Record<FleetStatusKind, number>;
    tokens: FleetTokenSummary[];
  };
  remoteFlag: {
    enabled: boolean;
    source: RemoteFlagSource;
  };
  remoteRuntimeRegistered: boolean;
}

const STATUS_META: Record<FleetStatusKind, { label: string; color: string; background: string; border: string }> = {
  running: { label: 'Running', color: '#15803d', background: 'rgba(22, 163, 74, 0.12)', border: 'rgba(22, 163, 74, 0.2)' },
  completed: { label: 'Completed', color: 'var(--t-text-secondary)', background: 'var(--t-bg-card)', border: 'var(--t-panel-border)' },
  failed: { label: 'Failed', color: '#dc2626', background: 'rgba(239, 68, 68, 0.12)', border: 'rgba(239, 68, 68, 0.2)' },
  cancelled: { label: 'Cancelled', color: '#b45309', background: 'rgba(245, 158, 11, 0.14)', border: 'rgba(245, 158, 11, 0.24)' },
};

function formatDate(value: string | null | undefined) {
  return value ? value.slice(0, 10) : '-';
}

function maskToken(prefix?: string) {
  return prefix ? `o8wt_${prefix}...` : 'o8wt_...';
}

function buildBreakdown(counts: Record<FleetStatusKind, number>) {
  return (['running', 'completed', 'failed', 'cancelled'] as FleetStatusKind[])
    .filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${status}`)
    .join(' · ');
}

function sourceCopy(source: RemoteFlagSource) {
  if (source === 'env') return 'Environment override: O8_ENABLE_REMOTE_RUNTIME=1';
  if (source === 'file') return 'Saved in o8 preferences for future launches';
  return 'Using the default startup setting';
}

export function WorkersTab() {
  const [data, setData] = useState<WorkersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState('customer-worker');
  const [maxWorkers, setMaxWorkers] = useState('10');
  const [creating, setCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState<{ id: string; plaintextToken: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [knownPrefixes, setKnownPrefixes] = useState<Record<string, string>>({});
  const [revokeTargetId, setRevokeTargetId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [flagBusy, setFlagBusy] = useState(false);
  const [draftRemoteEnabled, setDraftRemoteEnabled] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const response = await fetch('/api/panel/workers', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to load workers settings.');
      }
      setData(payload as WorkersResponse);
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to load workers settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    setDraftRemoteEnabled(data?.remoteFlag.enabled ?? false);
  }, [data?.remoteFlag.enabled, data?.remoteFlag.source]);

  const submitCreate = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!label.trim()) {
      setNotice('Token label is required.');
      return;
    }

    setCreating(true);
    try {
      const response = await fetch('/api/panel/workers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create_token',
          label: label.trim(),
          scope: scope.trim() || 'customer-worker',
          maxWorkers: Number.parseInt(maxWorkers, 10) || 10,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || typeof payload.id !== 'string' || typeof payload.plaintextToken !== 'string') {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to generate token.');
      }
      setKnownPrefixes((current) => ({
        ...current,
        [payload.id]: payload.plaintextToken.slice(5, 10),
      }));
      setCreatedToken({ id: payload.id, plaintextToken: payload.plaintextToken });
      setCopied(false);
      setNotice(null);
      setLabel('');
      setScope('customer-worker');
      setMaxWorkers('10');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to generate token.');
    } finally {
      setCreating(false);
    }
  }, [label, maxWorkers, scope]);

  const dismissCreatedToken = useCallback(async () => {
    setCreatedToken(null);
    setCopied(false);
    setFormOpen(false);
    await loadData();
  }, [loadData]);

  const copyCreatedToken = useCallback(async () => {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken.plaintextToken);
      setCopied(true);
      setNotice(null);
    } catch {
      setNotice('Clipboard access failed. Copy the token manually before dismissing.');
    }
  }, [createdToken]);

  const confirmRevoke = useCallback(async (id: string) => {
    setRevokingId(id);
    try {
      const response = await fetch('/api/panel/workers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'revoke_token', id }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to revoke token.');
      }
      setRevokeTargetId(null);
      setNotice(null);
      await loadData();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to revoke token.');
    } finally {
      setRevokingId(null);
    }
  }, [loadData]);

  const updateRemoteFlag = useCallback(async (enabled: boolean) => {
    setFlagBusy(true);
    try {
      const response = await fetch('/api/panel/workers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_remote_flag', enabled }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.remoteFlag) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to update remote runtime flag.');
      }
      setData(payload as WorkersResponse);
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to update remote runtime flag.');
    } finally {
      setFlagBusy(false);
    }
  }, []);

  if (loading && !data) {
    return (
      <div style={{ paddingTop: 32, paddingRight: 32, paddingBottom: 32, paddingLeft: 32, color: 'var(--t-text-muted)', fontSize: 13, fontFamily: APP_FONT_STACK }}>
        Loading workers...
      </div>
    );
  }

  const remoteFlag = data?.remoteFlag ?? { enabled: false, source: 'off' as const };
  const remoteRuntimeRegistered = data?.remoteRuntimeRegistered ?? false;
  const envControlled = remoteFlag.source === 'env';
  const tokens = data?.tokens ?? [];
  const fleetTokens = (data?.fleet.tokens ?? []).slice(0, 5);
  const remoteFlagDirty = draftRemoteEnabled !== remoteFlag.enabled;
  const restartRequired = remoteFlag.enabled !== remoteRuntimeRegistered;
  const restartAction = remoteFlag.enabled ? 'load' : 'unload';

  return (
    <div style={{ paddingTop: 32, paddingRight: 32, paddingBottom: 32, paddingLeft: 32, maxWidth: 860, fontFamily: APP_FONT_STACK }}>
      <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--t-text)', marginBottom: 6, letterSpacing: '-0.05em', lineHeight: 1 }}>
        Workers
      </div>
      <div style={{ fontSize: 14, color: 'var(--t-text-secondary)', marginBottom: 22, lineHeight: 1.5, maxWidth: 720 }}>
        Manage remote worker tokens, monitor recent fleet activity, and control the remote runtime feature flag used by desktop adapters.
      </div>

      {notice ? (
        <div style={{ marginBottom: 14, border: '1px solid rgba(239, 68, 68, 0.16)', borderRadius: 14, background: 'rgba(239, 68, 68, 0.08)', color: '#b91c1c', fontSize: 13, fontWeight: 600, paddingTop: 12, paddingRight: 14, paddingBottom: 12, paddingLeft: 14 }}>
          {notice}
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ border: '1px solid var(--t-panel-border)', borderRadius: 20, background: 'var(--t-panel)', paddingTop: 18, paddingRight: 18, paddingBottom: 18, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, minWidth: 0, flex: '1 1 480px' }}>
              <div style={{ width: 42, height: 42, borderRadius: 14, background: THEME_ACCENT_SOFT, border: `1px solid ${THEME_ACCENT_BORDER}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: THEME_ACCENT, flexShrink: 0 }}>
                <KeyIcon />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.03em', marginBottom: 4 }}>Worker tokens</div>
                <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>Generate tokens for remote workers. Plaintext is shown once at creation time and never returned again.</div>
              </div>
            </div>
            {!formOpen && !createdToken ? (
              <button type="button" onClick={() => { setFormOpen(true); setNotice(null); }} style={{ minHeight: 38, paddingTop: 0, paddingRight: 16, paddingBottom: 0, paddingLeft: 16, border: `1px solid ${THEME_ACCENT}`, borderRadius: 999, background: THEME_ACCENT, color: '#ffffff', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: APP_FONT_STACK }}>
                Generate token
              </button>
            ) : null}
          </div>

          {createdToken ? (
            <div style={{ border: `1px solid ${THEME_ACCENT_BORDER}`, borderRadius: 16, background: THEME_ACCENT_SOFT, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t-text)', marginBottom: 4 }}>Token created - copy it now</div>
                <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>This is the only time you&apos;ll see the full token. Revoke and regenerate if lost.</div>
              </div>
              <div style={{ border: '1px solid var(--t-panel-border)', borderRadius: 14, background: 'var(--t-input-bg)', color: 'var(--t-text)', fontSize: 13, fontWeight: 600, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: 1.5, wordBreak: 'break-all', paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12 }}>
                {createdToken.plaintextToken}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => { void copyCreatedToken(); }} style={{ minHeight: 36, paddingTop: 0, paddingRight: 14, paddingBottom: 0, paddingLeft: 14, border: `1px solid ${THEME_ACCENT}`, borderRadius: 999, background: THEME_ACCENT, color: '#ffffff', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: APP_FONT_STACK }}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button type="button" onClick={() => { void dismissCreatedToken(); }} style={{ minHeight: 36, paddingTop: 0, paddingRight: 14, paddingBottom: 0, paddingLeft: 14, border: '1px solid var(--t-panel-border)', borderRadius: 999, background: 'transparent', color: 'var(--t-text-secondary)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: APP_FONT_STACK }}>
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}

          {formOpen && !createdToken ? (
            <form onSubmit={submitCreate} style={{ border: '1px solid var(--t-panel-border)', borderRadius: 16, background: 'var(--t-bg-card)', paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                {[
                  { label: 'Label', value: label, setValue: setLabel, type: 'text', placeholder: 'Primary worker token' },
                  { label: 'Scope', value: scope, setValue: setScope, type: 'text', placeholder: 'customer-worker' },
                  { label: 'Max workers', value: maxWorkers, setValue: setMaxWorkers, type: 'number', placeholder: '10' },
                ].map((field) => (
                  <label key={field.label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text-secondary)' }}>{field.label}</span>
                    <input type={field.type} required={field.label === 'Label'} value={field.value} onChange={(event) => field.setValue(event.target.value)} placeholder={field.placeholder} style={{ height: 40, border: '1px solid var(--t-panel-border)', borderRadius: 12, background: 'var(--t-input-bg)', color: 'var(--t-text)', fontSize: 13, fontFamily: APP_FONT_STACK, outline: 'none', paddingTop: 0, paddingRight: 12, paddingBottom: 0, paddingLeft: 12 }} />
                  </label>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button type="submit" disabled={creating} style={{ minHeight: 36, paddingTop: 0, paddingRight: 14, paddingBottom: 0, paddingLeft: 14, border: `1px solid ${THEME_ACCENT}`, borderRadius: 999, background: THEME_ACCENT, color: '#ffffff', fontSize: 12, fontWeight: 700, cursor: creating ? 'default' : 'pointer', opacity: creating ? 0.7 : 1, fontFamily: APP_FONT_STACK }}>
                  {creating ? 'Generating...' : 'Generate token'}
                </button>
                <button type="button" onClick={() => { setFormOpen(false); setNotice(null); }} style={{ minHeight: 36, paddingTop: 0, paddingRight: 14, paddingBottom: 0, paddingLeft: 14, border: '1px solid var(--t-panel-border)', borderRadius: 999, background: 'transparent', color: 'var(--t-text-secondary)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: APP_FONT_STACK }}>
                  Cancel
                </button>
              </div>
            </form>
          ) : null}

          {tokens.length === 0 ? (
            <div style={{ border: '1px solid var(--t-panel-border)', borderRadius: 16, background: 'var(--t-bg-card)', color: 'var(--t-text-secondary)', fontSize: 13, lineHeight: 1.5, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16 }}>
              No worker tokens yet. Generate one to provision a remote worker with O8_WORKER_TOKEN.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {tokens.map((token) => (
                <div key={token.id} style={{ border: '1px solid var(--t-panel-border)', borderRadius: 16, background: 'var(--t-bg-card)', paddingTop: 14, paddingRight: 14, paddingBottom: 14, paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0, flex: '1 1 420px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--t-text)' }}>{token.label || 'Untitled token'}</span>
                        <span style={{ fontSize: 11, fontWeight: 700, color: THEME_ACCENT, background: THEME_ACCENT_SOFT, border: `1px solid ${THEME_ACCENT_BORDER}`, borderRadius: 999, paddingTop: 4, paddingRight: 10, paddingBottom: 4, paddingLeft: 10 }}>{token.scope}</span>
                        {token.revokedAt ? (
                          <span style={{ fontSize: 11, fontWeight: 700, color: '#b45309', background: 'rgba(245, 158, 11, 0.14)', border: '1px solid rgba(245, 158, 11, 0.24)', borderRadius: 999, paddingTop: 4, paddingRight: 10, paddingBottom: 4, paddingLeft: 10 }}>REVOKED</span>
                        ) : null}
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{maskToken(knownPrefixes[token.id])}</div>
                      <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
                        Created {formatDate(token.createdAt)} · Max workers {token.maxWorkers}
                        {token.revokedAt ? ` · Revoked at ${formatDate(token.revokedAt)}` : ''}
                      </div>
                    </div>
                    {!token.revokedAt && revokeTargetId !== token.id ? (
                      <button type="button" onClick={() => setRevokeTargetId(token.id)} style={{ minHeight: 34, paddingTop: 0, paddingRight: 12, paddingBottom: 0, paddingLeft: 12, border: '1px solid rgba(239, 68, 68, 0.2)', borderRadius: 999, background: 'transparent', color: '#dc2626', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: APP_FONT_STACK }}>
                        Revoke
                      </button>
                    ) : null}
                  </div>
                  {revokeTargetId === token.id && !token.revokedAt ? (
                    <div style={{ border: '1px solid rgba(239, 68, 68, 0.16)', borderRadius: 14, background: 'rgba(239, 68, 68, 0.08)', paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                      <div style={{ fontSize: 13, color: '#991b1b', lineHeight: 1.5 }}>Revoke this token? Workers using it will be cut off on next poll.</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <button type="button" onClick={() => { void confirmRevoke(token.id); }} disabled={revokingId === token.id} style={{ minHeight: 34, paddingTop: 0, paddingRight: 12, paddingBottom: 0, paddingLeft: 12, border: '1px solid rgba(239, 68, 68, 0.22)', borderRadius: 999, background: '#dc2626', color: '#ffffff', fontSize: 12, fontWeight: 700, cursor: revokingId === token.id ? 'default' : 'pointer', opacity: revokingId === token.id ? 0.7 : 1, fontFamily: APP_FONT_STACK }}>
                          {revokingId === token.id ? 'Revoking...' : 'Confirm'}
                        </button>
                        <button type="button" onClick={() => setRevokeTargetId(null)} style={{ minHeight: 34, paddingTop: 0, paddingRight: 12, paddingBottom: 0, paddingLeft: 12, border: '1px solid rgba(239, 68, 68, 0.16)', borderRadius: 999, background: 'transparent', color: '#991b1b', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: APP_FONT_STACK }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ border: '1px solid var(--t-panel-border)', borderRadius: 20, background: 'var(--t-panel)', paddingTop: 18, paddingRight: 18, paddingBottom: 18, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ width: 42, height: 42, borderRadius: 14, background: 'var(--t-bg-card)', border: '1px solid var(--t-panel-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-text-secondary)', flexShrink: 0 }}>
              <ActivityIcon />
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.03em', marginBottom: 4 }}>Fleet status</div>
              <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>Recent worker runs from the last 100 records. This section is read-only.</div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
            {(['running', 'completed', 'failed', 'cancelled'] as FleetStatusKind[]).map((status) => (
              <div key={status} style={{ border: `1px solid ${STATUS_META[status].border}`, borderRadius: 16, background: STATUS_META[status].background, paddingTop: 14, paddingRight: 14, paddingBottom: 14, paddingLeft: 14 }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', border: `1px solid ${STATUS_META[status].border}`, borderRadius: 999, background: 'transparent', color: STATUS_META[status].color, fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', paddingTop: 4, paddingRight: 10, paddingBottom: 4, paddingLeft: 10, marginBottom: 12 }}>{STATUS_META[status].label}</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--t-text)', letterSpacing: '-0.05em', lineHeight: 1 }}>{data?.fleet.counts[status] ?? 0}</div>
              </div>
            ))}
          </div>

          {fleetTokens.length === 0 ? (
            <div style={{ border: '1px solid var(--t-panel-border)', borderRadius: 16, background: 'var(--t-bg-card)', color: 'var(--t-text-secondary)', fontSize: 13, lineHeight: 1.5, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16 }}>
              No worker runs recorded yet. Generate a token and wire a worker with O8_WORKER_TOKEN.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {fleetTokens.map((token) => (
                <div key={token.tokenId} style={{ border: '1px solid var(--t-panel-border)', borderRadius: 16, background: 'var(--t-bg-card)', paddingTop: 14, paddingRight: 14, paddingBottom: 14, paddingLeft: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: '1 1 360px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--t-text)' }}>{token.label || 'Untitled token'}</span>
                      {token.hasActiveRuns ? (
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#15803d', background: 'rgba(22, 163, 74, 0.12)', border: '1px solid rgba(22, 163, 74, 0.2)', borderRadius: 999, paddingTop: 4, paddingRight: 10, paddingBottom: 4, paddingLeft: 10 }}>ACTIVE</span>
                      ) : null}
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>{token.totalRuns} runs · {buildBreakdown(token.counts)}</div>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>Last event {formatDate(token.lastRunAt)}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ border: '1px solid var(--t-panel-border)', borderRadius: 20, background: 'var(--t-panel)', paddingTop: 18, paddingRight: 18, paddingBottom: 18, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ width: 42, height: 42, borderRadius: 14, background: 'var(--t-bg-card)', border: '1px solid var(--t-panel-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-text-secondary)', flexShrink: 0 }}>
              <PlugIcon />
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.03em', marginBottom: 4 }}>Remote runtime toggle</div>
              <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>Control whether desktop can surface remote runtime adapters.</div>
            </div>
          </div>

          <label title={envControlled ? 'Controlled by environment variable; unset `O8_ENABLE_REMOTE_RUNTIME` to change from this UI.' : undefined} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, border: '1px solid var(--t-panel-border)', borderRadius: 16, background: 'var(--t-bg-card)', paddingTop: 14, paddingRight: 14, paddingBottom: 14, paddingLeft: 14, cursor: envControlled ? 'not-allowed' : 'pointer' }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t-text)', marginBottom: 4 }}>Enable remote runtime adapters on next launch</div>
              <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
                {remoteFlagDirty ? `Pending change: ${draftRemoteEnabled ? 'enable' : 'disable'} after Apply.` : sourceCopy(remoteFlag.source)}
              </div>
            </div>
            <span style={{ position: 'relative', width: 48, height: 28, borderRadius: 999, background: draftRemoteEnabled ? THEME_ACCENT : 'var(--t-input-bg)', border: draftRemoteEnabled ? `1px solid ${THEME_ACCENT}` : '1px solid var(--t-panel-border)', flexShrink: 0, opacity: flagBusy ? 0.7 : 1 }}>
              <input type="checkbox" checked={draftRemoteEnabled} disabled={envControlled || flagBusy} onChange={(event) => { setDraftRemoteEnabled(event.target.checked); setNotice(null); }} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: envControlled ? 'not-allowed' : 'pointer' }} />
              <span style={{ position: 'absolute', top: 3, left: draftRemoteEnabled ? 23 : 3, width: 20, height: 20, borderRadius: 999, background: '#ffffff', boxShadow: '0 4px 12px rgba(15, 23, 42, 0.18)', transition: 'left 180ms ease' }} />
            </span>
          </label>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', borderRadius: 999, border: remoteRuntimeRegistered ? '1px solid rgba(22, 163, 74, 0.2)' : '1px solid var(--t-panel-border)', background: remoteRuntimeRegistered ? 'rgba(22, 163, 74, 0.12)' : 'var(--t-bg-card)', color: remoteRuntimeRegistered ? '#15803d' : 'var(--t-text-secondary)', fontSize: 11, fontWeight: 700, paddingTop: 4, paddingRight: 10, paddingBottom: 4, paddingLeft: 10 }}>
              Current session: {remoteRuntimeRegistered ? 'loaded' : 'not loaded'}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', borderRadius: 999, border: remoteFlag.enabled ? `1px solid ${THEME_ACCENT_BORDER}` : '1px solid var(--t-panel-border)', background: remoteFlag.enabled ? THEME_ACCENT_SOFT : 'var(--t-bg-card)', color: remoteFlag.enabled ? THEME_ACCENT : 'var(--t-text-secondary)', fontSize: 11, fontWeight: 700, paddingTop: 4, paddingRight: 10, paddingBottom: 4, paddingLeft: 10 }}>
              Next launch: {remoteFlag.enabled ? 'enabled' : 'disabled'}
            </span>
          </div>

          {restartRequired ? (
            <div style={{ border: '1px solid rgba(245, 158, 11, 0.24)', borderRadius: 14, background: 'rgba(245, 158, 11, 0.12)', color: '#b45309', fontSize: 12, lineHeight: 1.5, paddingTop: 12, paddingRight: 14, paddingBottom: 12, paddingLeft: 14 }}>
              Restart o8 to {restartAction} remote runtime adapters. This desktop session stays {remoteRuntimeRegistered ? 'loaded' : 'unloaded'} until restart.
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
              Changes here apply on the next desktop launch. Hot-reloadable adapter registration is follow-up work.
            </div>
          )}

          {envControlled ? (
            <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
              The environment override owns this setting. Restart o8 without `O8_ENABLE_REMOTE_RUNTIME=1` to manage it from Settings.
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
                {remoteFlagDirty ? `Apply to ${draftRemoteEnabled ? 'enable' : 'disable'} remote runtime adapters for the next launch.` : 'No pending change.'}
              </div>
              <button type="button" onClick={() => { void updateRemoteFlag(draftRemoteEnabled); }} disabled={!remoteFlagDirty || flagBusy} style={{ minHeight: 36, paddingTop: 0, paddingRight: 14, paddingBottom: 0, paddingLeft: 14, border: `1px solid ${THEME_ACCENT}`, borderRadius: 999, background: THEME_ACCENT, color: '#ffffff', fontSize: 12, fontWeight: 700, cursor: !remoteFlagDirty || flagBusy ? 'default' : 'pointer', opacity: !remoteFlagDirty || flagBusy ? 0.6 : 1, fontFamily: APP_FONT_STACK }}>
                {flagBusy ? 'Applying...' : 'Apply (requires restart)'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
