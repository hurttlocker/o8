'use client';

/**
 * CloudWorkersTab — issue #514 v0 scaffolding
 *
 * Settings tab for the Cursor-style self-hosted cloud runtime. Lists the
 * service-account API keys that have been provisioned and surfaces a
 * "Generate API key" flow. Each key scopes to a team; cloud workers use the
 * plaintext key to connect outbound to /api/cloud/worker-poll.
 *
 * This is intentionally separate from the existing WorkersTab which lives on
 * the push-based `remote-customer` tier. When the two runtimes converge we
 * can merge the UIs, but mixing them in v0 would blur which credential tier
 * the operator is managing.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  APP_FONT_STACK,
  ActivityIcon,
  KeyIcon,
  THEME_ACCENT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_SOFT,
} from './shared';

interface CloudKeyRecord {
  id: string;
  teamId: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

interface CloudWorkersResponse {
  keys: CloudKeyRecord[];
  connectedWorkers: Array<{ workerId: string; lastSeenAt: string }>;
}

function formatDate(value: string | null | undefined) {
  return value ? value.slice(0, 10) : '-';
}

export function CloudWorkersTab() {
  const [data, setData] = useState<CloudWorkersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [teamId, setTeamId] = useState('team_default');
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<{ id: string; plaintextKey: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTargetId, setRevokeTargetId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const response = await fetch('/api/panel/cloud-workers', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to load cloud workers.');
      }
      setData(payload as CloudWorkersResponse);
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to load cloud workers.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  const submitCreate = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!label.trim()) {
      setNotice('Label is required.');
      return;
    }
    setCreating(true);
    try {
      const response = await fetch('/api/panel/cloud-workers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create_key', label: label.trim(), teamId: teamId.trim() || 'team_default' }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || typeof payload.id !== 'string' || typeof payload.plaintextKey !== 'string') {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to generate API key.');
      }
      setCreatedKey({ id: payload.id, plaintextKey: payload.plaintextKey });
      setCopied(false);
      setLabel('');
      setTeamId('team_default');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to generate API key.');
    } finally {
      setCreating(false);
    }
  }, [label, teamId]);

  const dismissCreated = useCallback(async () => {
    setCreatedKey(null);
    setCopied(false);
    setFormOpen(false);
    await loadData();
  }, [loadData]);

  const copyCreated = useCallback(async () => {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey.plaintextKey);
      setCopied(true);
      setNotice(null);
    } catch {
      setNotice('Clipboard access failed. Copy the key manually before dismissing.');
    }
  }, [createdKey]);

  const confirmRevoke = useCallback(async (id: string) => {
    setRevokingId(id);
    try {
      const response = await fetch('/api/panel/cloud-workers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'revoke_key', id }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to revoke key.');
      }
      setRevokeTargetId(null);
      await loadData();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to revoke key.');
    } finally {
      setRevokingId(null);
    }
  }, [loadData]);

  if (loading && !data) {
    return (
      <div style={{ paddingTop: 32, paddingRight: 32, paddingBottom: 32, paddingLeft: 32, color: 'var(--t-text-muted)', fontSize: 13, fontFamily: APP_FONT_STACK }}>
        Loading cloud workers...
      </div>
    );
  }

  const keys = data?.keys ?? [];
  const connectedWorkers = data?.connectedWorkers ?? [];

  return (
    <div style={{ paddingTop: 32, paddingRight: 32, paddingBottom: 32, paddingLeft: 32, maxWidth: 860, fontFamily: APP_FONT_STACK }}>
      <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--t-text)', marginBottom: 6, letterSpacing: '-0.05em', lineHeight: 1 }}>
        Cloud Workers
      </div>
      <div style={{ fontSize: 14, color: 'var(--t-text-secondary)', marginBottom: 22, lineHeight: 1.5, maxWidth: 720 }}>
        Provision API keys for self-hosted workers that run on your own infra. Workers open outbound-only HTTPS to the o8 backend, pick up dispatched jobs, and stream transcripts back. Planning stays centralized; execution stays inside your network.
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
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.03em', marginBottom: 4 }}>Service account keys</div>
                <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
                  Plaintext keys are shown once at creation time. Configure workers with <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 600 }}>O8_CLOUD_WORKER_KEY</span>.
                </div>
              </div>
            </div>
            {!formOpen && !createdKey ? (
              <button type="button" onClick={() => { setFormOpen(true); setNotice(null); }} style={{ minHeight: 38, paddingTop: 0, paddingRight: 16, paddingBottom: 0, paddingLeft: 16, border: `1px solid ${THEME_ACCENT}`, borderRadius: 999, background: THEME_ACCENT, color: '#ffffff', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: APP_FONT_STACK }}>
                Generate API key
              </button>
            ) : null}
          </div>

          {createdKey ? (
            <div style={{ border: `1px solid ${THEME_ACCENT_BORDER}`, borderRadius: 16, background: THEME_ACCENT_SOFT, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t-text)', marginBottom: 4 }}>Key generated - copy it now</div>
                <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
                  This is the only time the plaintext will be shown. Revoke and regenerate if lost.
                </div>
              </div>
              <div style={{ border: '1px solid var(--t-panel-border)', borderRadius: 14, background: 'var(--t-input-bg)', color: 'var(--t-text)', fontSize: 13, fontWeight: 600, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: 1.5, wordBreak: 'break-all', paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12 }}>
                {createdKey.plaintextKey}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => { void copyCreated(); }} style={{ minHeight: 36, paddingTop: 0, paddingRight: 14, paddingBottom: 0, paddingLeft: 14, border: `1px solid ${THEME_ACCENT}`, borderRadius: 999, background: THEME_ACCENT, color: '#ffffff', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: APP_FONT_STACK }}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button type="button" onClick={() => { void dismissCreated(); }} style={{ minHeight: 36, paddingTop: 0, paddingRight: 14, paddingBottom: 0, paddingLeft: 14, border: '1px solid var(--t-panel-border)', borderRadius: 999, background: 'transparent', color: 'var(--t-text-secondary)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: APP_FONT_STACK }}>
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}

          {formOpen && !createdKey ? (
            <form onSubmit={submitCreate} style={{ border: '1px solid var(--t-panel-border)', borderRadius: 16, background: 'var(--t-bg-card)', paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text-secondary)' }}>Label</span>
                  <input type="text" required value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Primary US-East pool" style={{ height: 40, border: '1px solid var(--t-panel-border)', borderRadius: 12, background: 'var(--t-input-bg)', color: 'var(--t-text)', fontSize: 13, fontFamily: APP_FONT_STACK, outline: 'none', paddingTop: 0, paddingRight: 12, paddingBottom: 0, paddingLeft: 12 }} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text-secondary)' }}>Team ID</span>
                  <input type="text" value={teamId} onChange={(event) => setTeamId(event.target.value)} placeholder="team_default" style={{ height: 40, border: '1px solid var(--t-panel-border)', borderRadius: 12, background: 'var(--t-input-bg)', color: 'var(--t-text)', fontSize: 13, fontFamily: APP_FONT_STACK, outline: 'none', paddingTop: 0, paddingRight: 12, paddingBottom: 0, paddingLeft: 12 }} />
                </label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button type="submit" disabled={creating} style={{ minHeight: 36, paddingTop: 0, paddingRight: 14, paddingBottom: 0, paddingLeft: 14, border: `1px solid ${THEME_ACCENT}`, borderRadius: 999, background: THEME_ACCENT, color: '#ffffff', fontSize: 12, fontWeight: 700, cursor: creating ? 'default' : 'pointer', opacity: creating ? 0.7 : 1, fontFamily: APP_FONT_STACK }}>
                  {creating ? 'Generating...' : 'Generate key'}
                </button>
                <button type="button" onClick={() => { setFormOpen(false); setNotice(null); }} style={{ minHeight: 36, paddingTop: 0, paddingRight: 14, paddingBottom: 0, paddingLeft: 14, border: '1px solid var(--t-panel-border)', borderRadius: 999, background: 'transparent', color: 'var(--t-text-secondary)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: APP_FONT_STACK }}>
                  Cancel
                </button>
              </div>
            </form>
          ) : null}

          {keys.length === 0 ? (
            <div style={{ border: '1px solid var(--t-panel-border)', borderRadius: 16, background: 'var(--t-bg-card)', color: 'var(--t-text-secondary)', fontSize: 13, lineHeight: 1.5, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16 }}>
              No cloud worker keys yet. Generate one to provision a self-hosted worker pool.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {keys.map((key) => (
                <div key={key.id} style={{ border: '1px solid var(--t-panel-border)', borderRadius: 16, background: 'var(--t-bg-card)', paddingTop: 14, paddingRight: 14, paddingBottom: 14, paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0, flex: '1 1 420px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--t-text)' }}>{key.label || 'Untitled key'}</span>
                        <span style={{ fontSize: 11, fontWeight: 700, color: THEME_ACCENT, background: THEME_ACCENT_SOFT, border: `1px solid ${THEME_ACCENT_BORDER}`, borderRadius: 999, paddingTop: 4, paddingRight: 10, paddingBottom: 4, paddingLeft: 10 }}>{key.teamId}</span>
                        {key.revokedAt ? (
                          <span style={{ fontSize: 11, fontWeight: 700, color: '#b45309', background: 'rgba(245, 158, 11, 0.14)', border: '1px solid rgba(245, 158, 11, 0.24)', borderRadius: 999, paddingTop: 4, paddingRight: 10, paddingBottom: 4, paddingLeft: 10 }}>REVOKED</span>
                        ) : null}
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{key.id}</div>
                      <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
                        Created {formatDate(key.createdAt)}
                        {key.revokedAt ? ` · Revoked ${formatDate(key.revokedAt)}` : ''}
                      </div>
                    </div>
                    {!key.revokedAt && revokeTargetId !== key.id ? (
                      <button type="button" onClick={() => setRevokeTargetId(key.id)} style={{ minHeight: 34, paddingTop: 0, paddingRight: 12, paddingBottom: 0, paddingLeft: 12, border: '1px solid rgba(239, 68, 68, 0.2)', borderRadius: 999, background: 'transparent', color: '#dc2626', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: APP_FONT_STACK }}>
                        Revoke
                      </button>
                    ) : null}
                  </div>
                  {revokeTargetId === key.id && !key.revokedAt ? (
                    <div style={{ border: '1px solid rgba(239, 68, 68, 0.16)', borderRadius: 14, background: 'rgba(239, 68, 68, 0.08)', paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                      <div style={{ fontSize: 13, color: '#991b1b', lineHeight: 1.5 }}>Revoke this key? Workers using it will be cut off on next poll.</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <button type="button" onClick={() => { void confirmRevoke(key.id); }} disabled={revokingId === key.id} style={{ minHeight: 34, paddingTop: 0, paddingRight: 12, paddingBottom: 0, paddingLeft: 12, border: '1px solid rgba(239, 68, 68, 0.22)', borderRadius: 999, background: '#dc2626', color: '#ffffff', fontSize: 12, fontWeight: 700, cursor: revokingId === key.id ? 'default' : 'pointer', opacity: revokingId === key.id ? 0.7 : 1, fontFamily: APP_FONT_STACK }}>
                          {revokingId === key.id ? 'Revoking...' : 'Confirm'}
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
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.03em', marginBottom: 4 }}>Connected workers</div>
              <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
                Workers currently long-polling <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 600 }}>/api/cloud/worker-poll</span>. Live discovery wires up when the worker CLI ships.
              </div>
            </div>
          </div>
          {connectedWorkers.length === 0 ? (
            <div style={{ border: '1px solid var(--t-panel-border)', borderRadius: 16, background: 'var(--t-bg-card)', color: 'var(--t-text-secondary)', fontSize: 13, lineHeight: 1.5, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16 }}>
              No workers connected yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {connectedWorkers.map((worker) => (
                <div key={worker.workerId} style={{ border: '1px solid var(--t-panel-border)', borderRadius: 16, background: 'var(--t-bg-card)', paddingTop: 14, paddingRight: 14, paddingBottom: 14, paddingLeft: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{worker.workerId}</div>
                  <div style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>Last seen {formatDate(worker.lastSeenAt)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
