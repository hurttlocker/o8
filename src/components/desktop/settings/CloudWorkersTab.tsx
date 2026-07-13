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
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  BracketLabel,
  ComingSoonBanner,
  FieldLabel,
  HairlineRule,
  SectionLabel,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
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
      <div style={{ paddingTop: 40, color: 'var(--t-text-muted)', fontSize: 13, fontFamily: APP_FONT_STACK }}>
        Loading cloud workers...
      </div>
    );
  }

  const keys = data?.keys ?? [];
  const connectedWorkers = data?.connectedWorkers ?? [];

  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 32,
      paddingBottom: 40,
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabHeading
        title="cloud workers"
        subtitle="API keys for self-hosted workers running on your own infra. Workers open outbound-only HTTPS to the o8 backend, pick up dispatched jobs, and stream transcripts back."
      />

      <div style={{ marginTop: 0, marginBottom: 32 }}>
        <ComingSoonBanner message="Cloud worker runtime is v0 scaffolding. You can mint keys and the /api/cloud/worker-poll endpoint is live, but there is no production worker runner yet. Key management below is safe to use — nothing executes against these keys yet." />
      </div>

      {notice ? (
        <div style={{
          marginBottom: 28,
          paddingTop: 2,
          paddingBottom: 2,
          fontSize: 13,
          color: 'var(--t-text)',
          lineHeight: 1.55,
        }}>
          <span style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 11,
            fontWeight: 300,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: '#ef4444',
            marginRight: 8,
          }}>
            [error]
          </span>
          {notice}
        </div>
      ) : null}

      {/* 01 — KEYS */}
      <section style={{ marginBottom: 32 }}>
        <SectionLabel number="01">KEYS</SectionLabel>

        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 20,
          paddingTop: 4,
          paddingBottom: 16,
          flexWrap: 'wrap',
        }}>
          <p style={{
            fontSize: 13,
            color: 'var(--t-text-secondary)',
            lineHeight: 1.55,
            maxWidth: 520,
            margin: 0,
          }}>
            Plaintext is shown once at creation. Configure workers with{' '}
            <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12, color: 'var(--t-text-secondary)' }}>O8_CLOUD_WORKER_KEY</span>.
          </p>

          {!formOpen && !createdKey ? (
            <button
              type="button"
              onClick={() => { setFormOpen(true); setNotice(null); }}
              style={accentLinkStyle(false)}
            >
              generate api key ›
            </button>
          ) : null}
        </div>

        {createdKey ? (
          <div style={{
            paddingTop: 12,
            paddingBottom: 12,
            marginBottom: 16,
          }}>
            <div style={{ marginBottom: 4 }}>
              <span style={{
                fontFamily: MONO_FONT_STACK,
                fontSize: 11,
                fontWeight: 300,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: RAMS_ACCENT,
                marginRight: 8,
              }}>
                [active]
              </span>
              <FieldLabel>key generated — copy now</FieldLabel>
            </div>
            <div style={{
              fontSize: 12,
              color: 'var(--t-text-secondary)',
              lineHeight: 1.55,
              marginTop: 4,
              marginBottom: 10,
            }}>
              This is the only time the plaintext will be shown. Revoke and regenerate if lost.
            </div>
            <div style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 12,
              fontWeight: 400,
              color: 'var(--t-text)',
              letterSpacing: '0.02em',
              lineHeight: 1.55,
              wordBreak: 'break-all',
              paddingTop: 10,
              paddingBottom: 10,
              borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`,
              borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
              marginBottom: 10,
            }}>
              {createdKey.plaintextKey}
            </div>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => { void copyCreated(); }} style={accentLinkStyle(false)}>
                {copied ? '(copied)' : 'copy ›'}
              </button>
              <button type="button" onClick={() => { void dismissCreated(); }} style={quietLinkStyle(false)}>
                dismiss
              </button>
            </div>
          </div>
        ) : null}

        {formOpen && !createdKey ? (
          <form onSubmit={submitCreate} style={{
            paddingTop: 16,
            paddingBottom: 16,
            borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`,
            borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            marginBottom: 16,
          }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 14,
            }}>
              <KeyField label="Label" value={label} setValue={setLabel} placeholder="Primary US-East pool" required />
              <KeyField label="Team ID" value={teamId} setValue={setTeamId} placeholder="team_default" />
            </div>
            <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="submit" disabled={creating} style={accentLinkStyle(creating)}>
                {creating ? 'generating...' : 'generate ›'}
              </button>
              <button type="button" onClick={() => { setFormOpen(false); setNotice(null); }} style={quietLinkStyle(false)}>
                cancel
              </button>
            </div>
          </form>
        ) : null}

        {keys.length === 0 ? (
          <div style={{
            paddingTop: 8,
            fontSize: 13,
            color: RAMS_INK_QUIET,
            lineHeight: 1.55,
          }}>
            No cloud worker keys yet. Generate one to provision a self-hosted worker pool.
          </div>
        ) : (
          <div style={{ borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}` }}>
            {keys.map((key) => (
              <div key={key.id} style={{
                paddingTop: 14,
                paddingBottom: 14,
                borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: '1 1 420px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 14, fontWeight: 300, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
                        {key.label || 'Untitled key'}
                      </span>
                      <BracketLabel tone="quiet">{key.teamId}</BracketLabel>
                      {key.revokedAt ? <BracketLabel tone="accent">revoked</BracketLabel> : null}
                    </div>
                    <div style={{ fontFamily: MONO_FONT_STACK, fontSize: 12, color: 'var(--t-text-secondary)', letterSpacing: '0.02em' }}>
                      {key.id}
                    </div>
                    <div style={{ fontSize: 12, color: RAMS_INK_QUIET, lineHeight: 1.55 }}>
                      Created {formatDate(key.createdAt)}
                      {key.revokedAt ? ` · Revoked ${formatDate(key.revokedAt)}` : ''}
                    </div>
                  </div>
                  {!key.revokedAt && revokeTargetId !== key.id ? (
                    <button type="button" onClick={() => setRevokeTargetId(key.id)} style={quietLinkStyle(false)}>
                      revoke
                    </button>
                  ) : null}
                </div>
                {revokeTargetId === key.id && !key.revokedAt ? (
                  <div style={{
                    paddingTop: 10,
                    paddingBottom: 4,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 16,
                    flexWrap: 'wrap',
                    borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`,
                  }}>
                    <div style={{ fontSize: 12, color: '#991b1b', lineHeight: 1.55 }}>
                      Revoke this key? Workers using it will be cut off on next poll.
                    </div>
                    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center' }}>
                      <button
                        type="button"
                        onClick={() => { void confirmRevoke(key.id); }}
                        disabled={revokingId === key.id}
                        style={{
                          ...accentLinkStyle(revokingId === key.id),
                          color: '#dc2626',
                          borderBottomColor: '#dc2626',
                        }}
                      >
                        {revokingId === key.id ? 'revoking...' : 'confirm ›'}
                      </button>
                      <button type="button" onClick={() => setRevokeTargetId(null)} style={quietLinkStyle(false)}>
                        cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 02 — CONNECTED WORKERS */}
      <section>
        <SectionLabel number="02">CONNECTED WORKERS</SectionLabel>
        <p style={{
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.55,
          maxWidth: 580,
          margin: 0,
          marginBottom: 14,
        }}>
          Workers currently long-polling{' '}
          <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12, color: 'var(--t-text-secondary)' }}>/api/cloud/worker-poll</span>.
          Live discovery wires up when the worker CLI ships.
        </p>

        {connectedWorkers.length === 0 ? (
          <div style={{ fontSize: 13, color: RAMS_INK_QUIET, lineHeight: 1.55 }}>
            No workers connected yet.
          </div>
        ) : (
          <div style={{ borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}` }}>
            {connectedWorkers.map((worker) => (
              <div key={worker.workerId} style={{
                paddingTop: 12,
                paddingBottom: 12,
                borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                flexWrap: 'wrap',
              }}>
                <div style={{ fontFamily: MONO_FONT_STACK, fontSize: 12, color: 'var(--t-text)', letterSpacing: '0.02em' }}>
                  {worker.workerId}
                </div>
                <div style={{ fontSize: 12, color: RAMS_INK_QUIET, fontFamily: MONO_FONT_STACK }}>
                  last seen {formatDate(worker.lastSeenAt)}
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 20 }}>
          <HairlineRule />
        </div>
      </section>
    </div>
  );
}

function KeyField({ label, value, setValue, placeholder, required = false }: {
  label: string;
  value: string;
  setValue: (v: string) => void;
  placeholder: string;
  required?: boolean;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <FieldLabel>{label}</FieldLabel>
      <input
        type="text"
        required={required}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        style={{
          border: 'none',
          borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
          background: 'transparent',
          color: 'var(--t-text)',
          fontSize: 14,
          fontFamily: APP_FONT_STACK,
          fontWeight: 400,
          letterSpacing: '-0.005em',
          outline: 'none',
          paddingTop: 6,
          paddingBottom: 6,
          paddingLeft: 0,
          paddingRight: 0,
        }}
        onFocus={(e) => { e.currentTarget.style.borderBottomColor = RAMS_ACCENT; }}
        onBlur={(e) => { e.currentTarget.style.borderBottomColor = RAMS_HAIRLINE_SOFT; }}
      />
    </label>
  );
}

function accentLinkStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    minHeight: 32,
    paddingLeft: 14,
    paddingRight: 14,
    borderRadius: 9,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: disabled ? RAMS_HAIRLINE_SOFT : 'var(--t-settings-accent-active-border, rgba(29, 78, 216, 0.32))',
    background: disabled ? 'transparent' : 'var(--t-settings-accent-active-bg, rgba(29, 78, 216, 0.1))',
    color: disabled ? RAMS_INK_QUIET : RAMS_ACCENT,
    fontFamily: APP_FONT_STACK,
    fontSize: 12,
    fontWeight: 400,
    letterSpacing: '-0.01em',
    textTransform: 'capitalize' as const,
    cursor: disabled ? 'default' : 'pointer',
    transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
    opacity: disabled ? 0.6 : 1,
  };
}

function quietLinkStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: 32,
    fontFamily: APP_FONT_STACK,
    fontSize: 12,
    fontWeight: 400,
    color: 'var(--t-text-muted)',
    background: 'transparent',
    border: 'none',
    borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
    paddingTop: 2,
    paddingBottom: 2,
    paddingLeft: 0,
    paddingRight: 0,
    cursor: disabled ? 'default' : 'pointer',
    letterSpacing: '-0.01em',
    opacity: disabled ? 0.6 : 1,
  };
}
