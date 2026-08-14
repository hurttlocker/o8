'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  CODEX_SUBSCRIPTION_CLAUDE_CODE_DEFAULT_MODEL,
  CLAUDE_CODE_PROFILE_CHANGED_EVENT,
  OPENROUTER_CLAUDE_CODE_DEFAULT_MODEL,
  type ClaudeCodeModelSource,
  type ClaudeCodeWorkerProfile,
} from '@/lib/claude-code/worker-profile-types';
import { AcpModelPickerPopover } from './AcpModelPickerPopover';
import { PickerMenu } from './dispatch-shared';
import { SettingsGroup, SettingsRow, ValuePill } from './grouped';

type ProfileResponse = {
  ok: boolean;
  profile: ClaudeCodeWorkerProfile;
  effectiveModel: string | null;
  openrouterConfigured: boolean;
  billing: 'api' | 'provider-account' | 'codex-subscription';
  codexSubscriptionSupported: true;
  codexSubscriptionReason: string;
  codexProxy: {
    installed: boolean;
    authenticated: boolean;
    running: boolean;
    connecting: boolean;
    modelCount: number;
    error?: string;
  };
  error?: string;
};

const SOURCE_OPTIONS: Array<{ value: ClaudeCodeModelSource; label: string; detail: string }> = [
  { value: 'native', label: 'Native account', detail: 'Use the existing Claude Code login or inherited gateway.' },
  { value: 'openrouter', label: 'OpenRouter', detail: 'Run the Claude Code harness against an API-billed model.' },
  { value: 'codex-subscription', label: 'Codex subscription', detail: 'Route Claude Code through a localhost Codex OAuth carrier.' },
];

function HarnessIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M4 7h16M7 4v6m10-6v6M6 14h4v4H6zm8 0h4v4h-4z" />
    </svg>
  );
}

export function ClaudeCodeHarnessSection() {
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/runtime/claude-code-profile', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({})) as ProfileResponse;
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? 'Claude Code worker settings are unavailable.');
      setData(payload);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Claude Code worker settings are unavailable.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!data?.codexProxy.connecting) return;
    const timer = window.setInterval(() => { void load(); }, 1_000);
    return () => window.clearInterval(timer);
  }, [data?.codexProxy.connecting, load]);

  const save = useCallback(async (profile: ClaudeCodeWorkerProfile) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/runtime/claude-code-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile),
      });
      const payload = await response.json().catch(() => ({})) as ProfileResponse;
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? 'Claude Code worker settings could not be saved.');
      setData(payload);
      window.dispatchEvent(new Event(CLAUDE_CODE_PROFILE_CHANGED_EVENT));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Claude Code worker settings could not be saved.');
    } finally {
      setBusy(false);
    }
  }, []);

  const connectCodex = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/runtime/claude-code-codex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'connect' }),
      });
      const payload = await response.json().catch(() => ({})) as {
        ok?: boolean;
        error?: string;
        status?: ProfileResponse['codexProxy'];
      };
      if (!response.ok && response.status !== 202) {
        throw new Error(payload.error ?? 'The Codex subscription connection could not start.');
      }
      if (payload.status) setData((current) => current ? { ...current, codexProxy: payload.status! } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The Codex subscription connection could not start.');
    } finally {
      setBusy(false);
    }
  }, []);

  if (!data) {
    return (
      <SettingsGroup header="Claude Code harness" footnote={error ?? 'Loading the harness carrier…'}>
        <SettingsRow icon={<HarnessIcon />} label="Model source" value="Loading…" disabled />
      </SettingsGroup>
    );
  }

  const profile = data.profile;
  const gatewayModel = profile.model ?? OPENROUTER_CLAUDE_CODE_DEFAULT_MODEL;
  const codexModel = profile.codexModel ?? CODEX_SUBSCRIPTION_CLAUDE_CODE_DEFAULT_MODEL;
  const gatewayActive = profile.source === 'openrouter';
  const codexActive = profile.source === 'codex-subscription';

  return (
    <SettingsGroup
      header="Claude Code harness"
      footnote={error ?? (gatewayActive
        ? 'Each orchestrator chat gets its own resident Claude Code session and config. OpenRouter supplies the model and bills the API usage; your Claude and Codex subscriptions are not charged.'
        : codexActive
          ? 'Each orchestrator chat gets its own resident Claude Code session and config while Codex supplies the model through a localhost-only OAuth proxy. Usage counts against the connected Codex subscription quota.'
          : 'Native uses the existing Claude Code login or inherited enterprise gateway. Each orchestrator chat keeps its own resident session, and each worker pins the selected source when it starts.')}
    >
      <SettingsRow
        icon={<HarnessIcon />}
        label="Model source"
        subtitle="Choose who supplies the model behind Claude Code orchestrators and workers"
        accessory={
          <PickerMenu<ClaudeCodeModelSource>
            value={profile.source}
            options={SOURCE_OPTIONS}
            onChange={(source) => { void save({ source, model: profile.model, codexModel: profile.codexModel }); }}
            disabled={busy}
            minWidth={150}
          />
        }
        divider
      />
      {gatewayActive ? (
        <SettingsRow
          icon={<HarnessIcon />}
          label="Harness model"
          subtitle="Live tool-capable OpenRouter catalogue"
          accessory={
            <AcpModelPickerPopover
              backend="claude-code-openrouter"
              catalogueUrl="/api/runtime/claude-code-models"
              label={gatewayModel}
              value={gatewayModel}
              onSelect={(model) => { void save({ ...profile, source: 'openrouter', model }); }}
              onClear={() => { void save({ ...profile, source: 'openrouter', model: null }); }}
              disabled={busy}
            />
          }
          divider
        />
      ) : null}
      {codexActive ? (
        <SettingsRow
          icon={<HarnessIcon />}
          label="Codex connection"
          subtitle={!data.codexProxy.installed
            ? 'Install CLIProxyAPI with Homebrew before connecting'
            : data.codexProxy.authenticated
              ? 'OAuth is stored locally with owner-only permissions'
              : 'A browser window will ask you to authorize Codex once'}
          accessory={data.codexProxy.authenticated ? (
            <ValuePill tone={data.codexProxy.running ? 'success' : 'default'}>
              {data.codexProxy.running ? 'Ready' : 'Connected'}
            </ValuePill>
          ) : (
            <button
              type="button"
              onClick={() => { void connectCodex(); }}
              disabled={busy || !data.codexProxy.installed || data.codexProxy.connecting}
              style={{
                minHeight: 36,
                paddingTop: 0,
                paddingRight: 12,
                paddingBottom: 0,
                paddingLeft: 12,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-border)',
                borderRadius: 9,
                background: 'var(--t-input-bg)',
                color: 'var(--t-text)',
                fontFamily: 'var(--font-sans-system)',
                fontSize: 12,
                cursor: busy || !data.codexProxy.installed ? 'not-allowed' : 'pointer',
                opacity: busy || !data.codexProxy.installed ? 0.55 : 1,
              }}
            >
              {data.codexProxy.connecting ? 'Waiting for browser…' : 'Connect Codex'}
            </button>
          )}
          divider
        />
      ) : null}
      {codexActive && data.codexProxy.authenticated ? (
        <SettingsRow
          icon={<HarnessIcon />}
          label="Harness model"
          subtitle="Models reported by the connected Codex subscription"
          accessory={
            <AcpModelPickerPopover
              backend="claude-code-codex-subscription"
              catalogueUrl="/api/runtime/claude-code-codex-models"
              label={codexModel}
              value={codexModel}
              onSelect={(model) => { void save({ ...profile, source: 'codex-subscription', codexModel: model }); }}
              onClear={() => { void save({ ...profile, source: 'codex-subscription', codexModel: null }); }}
              disabled={busy}
            />
          }
          divider
        />
      ) : null}
      <SettingsRow
        icon={<HarnessIcon />}
        label="Billing"
        subtitle={gatewayActive
          ? 'Requires the encrypted OpenRouter key in API Keys below'
          : codexActive
            ? 'No API key; worker turns consume the connected Codex subscription quota'
            : 'Uses the account or gateway already configured in Claude Code'}
        accessory={<ValuePill tone={(gatewayActive && !data.openrouterConfigured) || (codexActive && !data.codexProxy.authenticated) ? 'destructive' : 'default'}>
          {gatewayActive
            ? (data.openrouterConfigured ? 'API billed' : 'Key required')
            : codexActive
              ? (data.codexProxy.authenticated ? 'Subscription quota' : 'Connect required')
              : 'Account billed'}
        </ValuePill>}
        divider
      />
      <SettingsRow
        icon={<HarnessIcon />}
        label="Codex subscription"
        subtitle={data.codexSubscriptionReason}
        accessory={<ValuePill>Experimental</ValuePill>}
      />
    </SettingsGroup>
  );
}
