'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_CONTROL_BG,
  RAMS_CONTROL_BORDER,
  RAMS_CONTROL_ACTIVE_BG,
  RAMS_CONTROL_ACTIVE_BORDER,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  BracketLabel,
  ComingSoonBanner,
  FieldLabel,
  HairlineRule,
  SectionLabel,
  SettingsToggleButton,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
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
  if (source === 'file') return 'Saved in o8 preferences for future launches.';
  return 'Using the default startup setting.';
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
      <div style={{ paddingTop: 40, color: 'var(--t-text-muted)', fontSize: 13, fontFamily: APP_FONT_STACK }}>
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
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 32,
      paddingBottom: 40,
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabHeading
        title="workers"
        subtitle="Manage remote worker tokens, monitor fleet activity, and control the remote runtime flag used by desktop adapters."
      />

      <div style={{ marginTop: 0, marginBottom: 32 }}>
        <ComingSoonBanner message="Remote worker execution is scaffolded but not yet shipped. Token minting and fleet views below are live so you can stage credentials, but nothing actually runs against these tokens yet." />
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

      {/* 01 — TOKENS */}
      <section style={{ marginBottom: 32 }}>
        <SectionLabel number="01">TOKENS</SectionLabel>

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
            Generate tokens for remote workers. Plaintext is shown once at creation time and never returned again.
          </p>

          {!formOpen && !createdToken ? (
            <button
              type="button"
              onClick={() => { setFormOpen(true); setNotice(null); }}
              style={accentLinkStyle(false)}
            >
              generate token ›
            </button>
          ) : null}
        </div>

        {createdToken ? (
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
              <FieldLabel>token created — copy now</FieldLabel>
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
              paddingLeft: 0,
              paddingRight: 0,
              borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`,
              borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
              marginBottom: 10,
            }}>
              {createdToken.plaintextToken}
            </div>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => { void copyCreatedToken(); }} style={accentLinkStyle(false)}>
                {copied ? '(copied)' : 'copy ›'}
              </button>
              <button type="button" onClick={() => { void dismissCreatedToken(); }} style={quietLinkStyle(false)}>
                dismiss
              </button>
            </div>
          </div>
        ) : null}

        {formOpen && !createdToken ? (
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
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 14,
            }}>
              <TokenField label="Label" value={label} setValue={setLabel} placeholder="Primary worker token" />
              <TokenField label="Scope" value={scope} setValue={setScope} placeholder="customer-worker" />
              <TokenField label="Max workers" value={maxWorkers} setValue={setMaxWorkers} placeholder="10" type="number" />
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

        {tokens.length === 0 ? (
          <div style={{
            paddingTop: 8,
            fontSize: 13,
            color: RAMS_INK_QUIET,
            lineHeight: 1.55,
          }}>
            No worker tokens yet. Generate one to provision a remote worker with{' '}
            <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12 }}>O8_WORKER_TOKEN</span>.
          </div>
        ) : (
          <div style={{ borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}` }}>
            {tokens.map((token) => (
              <div key={token.id} style={{
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
                        {token.label || 'Untitled token'}
                      </span>
                      <BracketLabel tone="quiet">{token.scope}</BracketLabel>
                      {token.revokedAt ? <BracketLabel tone="accent">revoked</BracketLabel> : null}
                    </div>
                    <div style={{ fontFamily: MONO_FONT_STACK, fontSize: 12, color: 'var(--t-text-secondary)', letterSpacing: '0.02em' }}>
                      {maskToken(knownPrefixes[token.id])}
                    </div>
                    <div style={{ fontSize: 12, color: RAMS_INK_QUIET, lineHeight: 1.55 }}>
                      Created {formatDate(token.createdAt)} · Max workers {token.maxWorkers}
                      {token.revokedAt ? ` · Revoked ${formatDate(token.revokedAt)}` : ''}
                    </div>
                  </div>
                  {!token.revokedAt && revokeTargetId !== token.id ? (
                    <button type="button" onClick={() => setRevokeTargetId(token.id)} style={quietLinkStyle(false)}>
                      revoke
                    </button>
                  ) : null}
                </div>
                {revokeTargetId === token.id && !token.revokedAt ? (
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
                      Revoke this token? Workers using it will be cut off on next poll.
                    </div>
                    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center' }}>
                      <button
                        type="button"
                        onClick={() => { void confirmRevoke(token.id); }}
                        disabled={revokingId === token.id}
                        style={{
                          ...accentLinkStyle(revokingId === token.id),
                          color: '#dc2626',
                          borderBottomColor: '#dc2626',
                        }}
                      >
                        {revokingId === token.id ? 'revoking...' : 'confirm ›'}
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

      {/* 02 — FLEET */}
      <section style={{ marginBottom: 32 }}>
        <SectionLabel number="02">FLEET</SectionLabel>
        <p style={{
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.55,
          maxWidth: 580,
          margin: 0,
          marginBottom: 14,
        }}>
          Recent worker runs from the last 100 records. Read-only.
        </p>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`,
          borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
          marginBottom: 16,
        }}>
          {(['running', 'completed', 'failed', 'cancelled'] as FleetStatusKind[]).map((status, idx) => (
            <div key={status} style={{
              paddingTop: 14,
              paddingBottom: 14,
              paddingLeft: 14,
              paddingRight: 14,
              borderRight: idx === 3 ? 'none' : `1px solid ${RAMS_HAIRLINE_SOFT}`,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}>
              <FieldLabel>{status}</FieldLabel>
              <div style={{
                fontSize: 26,
                fontWeight: 400,
                color: 'var(--t-text)',
                letterSpacing: '-0.02em',
                lineHeight: 1,
                fontFamily: APP_FONT_STACK,
              }}>
                {data?.fleet.counts[status] ?? 0}
              </div>
            </div>
          ))}
        </div>

        {fleetTokens.length === 0 ? (
          <div style={{ fontSize: 13, color: RAMS_INK_QUIET, lineHeight: 1.55 }}>
            No worker runs recorded yet.
          </div>
        ) : (
          <div style={{ borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}` }}>
            {fleetTokens.map((token) => (
              <div key={token.tokenId} style={{
                paddingTop: 12,
                paddingBottom: 12,
                borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                flexWrap: 'wrap',
              }}>
                <div style={{ minWidth: 0, flex: '1 1 360px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
                    <span style={{ fontSize: 14, fontWeight: 300, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
                      {token.label || 'Untitled token'}
                    </span>
                    {token.hasActiveRuns ? <BracketLabel tone="accent">active</BracketLabel> : null}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.55 }}>
                    {token.totalRuns} runs · {buildBreakdown(token.counts)}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: RAMS_INK_QUIET, fontFamily: MONO_FONT_STACK }}>
                  last {formatDate(token.lastRunAt)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 03 — REMOTE RUNTIME */}
      <section>
        <SectionLabel number="03">REMOTE RUNTIME</SectionLabel>
        <p style={{
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.55,
          maxWidth: 580,
          margin: 0,
          marginBottom: 14,
        }}>
          Control whether desktop surfaces remote runtime adapters.
        </p>

        <div
          title={envControlled ? 'Controlled by environment variable; unset O8_ENABLE_REMOTE_RUNTIME to change from this UI.' : undefined}
          style={{
            paddingTop: 14,
            paddingBottom: 14,
            borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`,
            borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 20,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: 0, maxWidth: 520 }}>
            <div style={{ fontSize: 14, fontWeight: 300, color: 'var(--t-text)', marginBottom: 4, letterSpacing: '-0.01em' }}>
              Enable on next launch
            </div>
            <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.55 }}>
              {remoteFlagDirty
                ? `Pending change: ${draftRemoteEnabled ? 'enable' : 'disable'} after Apply.`
                : sourceCopy(remoteFlag.source)}
            </div>
          </div>
          <SettingsToggleButton
            checked={draftRemoteEnabled}
            onChange={(next) => { if (!envControlled && !flagBusy) { setDraftRemoteEnabled(next); setNotice(null); } }}
            disabled={envControlled || flagBusy}
          />
        </div>

        <div style={{
          display: 'flex',
          gap: 20,
          paddingTop: 10,
          paddingBottom: 10,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}>
          <BracketLabel tone="quiet">
            current: {remoteRuntimeRegistered ? 'loaded' : 'not loaded'}
          </BracketLabel>
          <BracketLabel tone={remoteFlag.enabled ? 'accent' : 'quiet'}>
            next: {remoteFlag.enabled ? 'enabled' : 'disabled'}
          </BracketLabel>
        </div>

        {restartRequired ? (
          <div style={{
            paddingTop: 2,
            paddingBottom: 2,
            fontSize: 12,
            color: 'var(--t-text-secondary)',
            lineHeight: 1.55,
            marginBottom: 14,
          }}>
            <span style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 11,
              fontWeight: 300,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: '#f59e0b',
              marginRight: 8,
            }}>
              [warn]
            </span>
            Restart o8 to {restartAction} remote runtime adapters. This session stays {remoteRuntimeRegistered ? 'loaded' : 'unloaded'} until restart.
          </div>
        ) : (
          <div style={{ fontSize: 12, color: RAMS_INK_QUIET, lineHeight: 1.55, marginBottom: 14 }}>
            Changes apply on the next desktop launch. Hot-reloadable adapter registration is follow-up work.
          </div>
        )}

        {envControlled ? (
          <div style={{ fontSize: 12, color: RAMS_INK_QUIET, lineHeight: 1.55 }}>
            The environment override owns this setting. Restart o8 without{' '}
            <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 11 }}>O8_ENABLE_REMOTE_RUNTIME=1</span>{' '}
            to manage it here.
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.55 }}>
              {remoteFlagDirty
                ? `Apply to ${draftRemoteEnabled ? 'enable' : 'disable'} adapters for the next launch.`
                : 'No pending change.'}
            </div>
            <button
              type="button"
              onClick={() => { void updateRemoteFlag(draftRemoteEnabled); }}
              disabled={!remoteFlagDirty || flagBusy}
              style={accentLinkStyle(!remoteFlagDirty || flagBusy)}
            >
              {flagBusy ? 'applying...' : 'apply (requires restart) ›'}
            </button>
          </div>
        )}

        <div style={{ marginTop: 20 }}>
          <HairlineRule />
        </div>
      </section>
    </div>
  );
}

function TokenField({ label, value, setValue, placeholder, type = 'text' }: {
  label: string;
  value: string;
  setValue: (v: string) => void;
  placeholder: string;
  type?: string;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <FieldLabel>{label}</FieldLabel>
      <input
        type={type}
        required={label === 'Label'}
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
    justifyContent: 'center',
    gap: 8,
    minHeight: 32,
    paddingLeft: 14,
    paddingRight: 14,
    borderRadius: 9,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: disabled ? RAMS_CONTROL_BORDER : RAMS_CONTROL_ACTIVE_BORDER,
    background: disabled ? 'transparent' : RAMS_CONTROL_ACTIVE_BG,
    color: disabled ? RAMS_INK_QUIET : RAMS_ACCENT,
    fontFamily: APP_FONT_STACK,
    fontSize: 12,
    fontWeight: 400,
    letterSpacing: '-0.01em',
    textTransform: 'capitalize' as const,
    cursor: disabled ? 'default' : 'pointer',
    transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
    opacity: disabled ? 0.6 : 1,
  };
}

function quietLinkStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 32,
    paddingLeft: 14,
    paddingRight: 14,
    borderRadius: 9,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: RAMS_CONTROL_BORDER,
    background: disabled ? 'transparent' : RAMS_CONTROL_BG,
    fontFamily: APP_FONT_STACK,
    fontSize: 12,
    fontWeight: 400,
    letterSpacing: '-0.01em',
    textTransform: 'capitalize' as const,
    color: 'var(--t-text-secondary)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
  };
}
