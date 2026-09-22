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
  { value: 'native', label: 'Existing Claude connection', detail: 'Use the existing Claude Code login or inherited gateway.' },
  { value: 'openrouter', label: 'OpenRouter', detail: 'Use OpenRouter models, billed to your API key.' },
  { value: 'codex-subscription', label: 'Codex subscription (experimental)', detail: 'Unofficial local compatibility connection; uses Codex subscription quota.' },
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
        body: JSON.stringify({ source: profile.source, model: profile.model, codexModel: profile.codexModel }),
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
      <SettingsGroup header="Claude Code connection" footnote={error ?? 'Checking the Claude Code connection…'}>
        <SettingsRow icon={<HarnessIcon />} label="Model source" value="Loading…" disabled />
      </SettingsGroup>
    );
  }

  const profile = data.profile;
  const gatewayModel = profile.model ?? OPENROUTER_CLAUDE_CODE_DEFAULT_MODEL;
  const codexModel = profile.codexModel ?? CODEX_SUBSCRIPTION_CLAUDE_CODE_DEFAULT_MODEL;
  const gatewayActive = profile.source === 'openrouter';
  const codexActive = profile.source === 'codex-subscription';
  const sourceOptions = SOURCE_OPTIONS.filter((option) => (
    option.value !== 'openrouter' || data.openrouterConfigured || gatewayActive
  ));

  return (
    <SettingsGroup
      header="Claude Code connection"
      footnote={error ?? (gatewayActive
        ? 'OpenRouter supplies the model and bills your API key for usage. Configure that key in API keys. New sessions and workers use this connection.'
        : codexActive
          ? 'Experimental: an unofficial local compatibility proxy supplies Codex models to Claude Code. Connect Codex before starting tasks. Usage counts against that subscription quota.'
          : 'Uses the account or enterprise gateway already configured in Claude Code. Its usage terms apply. Choose task models in the composer; manage worker skills in Customize → Skills.')}
    >
      <SettingsRow
        icon={<HarnessIcon />}
        label="Model source"
        subtitle="Choose the account or API that powers Claude Code orchestrators and workers."
        accessory={
          <PickerMenu<ClaudeCodeModelSource>
            value={profile.source}
            options={sourceOptions}
            onChange={(source) => { void save({ ...profile, source }); }}
            disabled={busy}
            minWidth={150}
          />
        }
        divider
      />
      {gatewayActive ? (
        <SettingsRow
          icon={<HarnessIcon />}
          label="Model"
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
          label="Codex authorization"
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
          label="Model"
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
    </SettingsGroup>
  );
}
