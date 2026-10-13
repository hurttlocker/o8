'use client';

import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import { SettingsGroup, SettingsRow } from './grouped';
import { SettingsToggleButton } from './shared';
import { PickerMenu, CODEX_WORKER_EFFORT_OPTIONS, CLAUDE_WORKER_EFFORT_OPTIONS, ORCHESTRATOR_MODEL_OPTIONS, ENV_LOCKED_REASON, type ThinkingEffort } from './dispatch-shared';
import type { useModelSettings } from './useModelSettings';
import { ClaudeCodeHarnessSection } from './ClaudeCodeHarnessSection';
import { ProviderUsageSection } from './ProviderUsageSection';
import { MuseConnectionSection } from './MuseConnectionSection';

export interface ProviderTool {
  id: string;
  detected: boolean;
  ready?: boolean;
  authHint?: string;
  version?: string;
  path?: string;
}

export function providerToolStatus(tool?: ProviderTool): string {
  if (!tool) return 'Not checked';
  if (!tool.detected) return 'Not installed';
  return tool.ready === true ? 'Ready' : tool.ready === false ? 'Sign in required' : 'Installed';
}

export function ProviderRuntimeDetails({ runtimeId, tool, checking, detectionError, settings }: {
  runtimeId: keyof typeof ORCHESTRATOR_RUNTIMES;
  tool?: ProviderTool;
  checking: boolean;
  detectionError: boolean;
  settings: ReturnType<typeof useModelSettings>;
}) {
  const runtime = ORCHESTRATOR_RUNTIMES[runtimeId];
  const { data, loading, notice, busyField, updateField } = settings;
  const effortField = runtimeId === 'codex' ? 'codexWorkerEffort' : runtimeId === 'claude-code' ? 'claudeWorkerEffort' : null;
  const locked = effortField ? data?.sources[effortField] === 'env' : false;

  if (runtimeId === 'pi-builtin') {
    const readiness = data?.dispatchableRuntimes?.find(item => item.id === runtimeId);
    return <SettingsGroup header="Built-in worker">
      <SettingsRow label="Availability" value={loading ? 'Checking…' : readiness?.available ? 'Ready' : 'Unavailable'} subtitle={readiness?.detail ?? 'Could not read readiness. Reopen Settings to retry.'} divider />
      <SettingsRow label="Managed model" subtitle="Included with o8. No separate CLI or API key needed." divider />
      <SettingsRow label="Use in a conversation" subtitle="Choose o8 for the orchestrator, or Pi (built-in) for workers." divider />
      {!readiness?.available && readiness?.fix ? <SettingsRow label="Setup" subtitle={readiness.fix} /> : null}
    </SettingsGroup>;
  }

  return <div style={{ display: 'grid', gap: 24 }}>
    <SettingsGroup header={`${runtime.label} runtime`}>
      <SettingsRow label="Account status" subtitle={tool?.authHint ?? 'Sign in through the provider’s own CLI.'} value={checking ? 'Checking…' : detectionError ? 'Check unavailable' : providerToolStatus(tool)} divider />
      <SettingsRow label="Version" value={tool?.version ?? 'Not reported'} divider />
      <SettingsRow label="Binary path" subtitle={tool?.path ?? runtime.binaryName} />
    </SettingsGroup>
    {notice ? <p role="alert" style={{ margin: 0, color: 'var(--t-text)' }}>{notice}</p> : null}
    {runtimeId === 'muse' ? <MuseConnectionSection /> : null}
    {effortField || runtimeId === 'opencode' ? <SettingsGroup header={`${runtime.label} models`}>
      <SettingsRow label="Model selection" subtitle="Choose conversation models in the composer. App routing is in Model defaults." divider />
      {effortField && data ? <SettingsRow label="Worker effort" subtitle={locked ? ENV_LOCKED_REASON : 'Used when a worker has no effort choice.'} accessory={
        <PickerMenu<ThinkingEffort> value={data.values[effortField]} options={runtimeId === 'codex' ? CODEX_WORKER_EFFORT_OPTIONS : CLAUDE_WORKER_EFFORT_OPTIONS}
          onChange={value => { updateField(effortField, value); }} disabled={locked || busyField !== null} minWidth={130} />
      } /> : loading ? <SettingsRow label="Loading model settings…" /> : null}
      {runtimeId === 'opencode' && data ? <SettingsRow label="Show in dispatch pickers" subtitle={data.sources.experimentalOpencode === 'env' ? ENV_LOCKED_REASON : 'Allow OpenCode as a worker choice.'} accessory={
        <SettingsToggleButton checked={data.values.experimentalOpencode} disabled={data.sources.experimentalOpencode === 'env' || busyField !== null} onChange={value => { updateField('experimentalOpencode', value); }} />
      } /> : null}
    </SettingsGroup> : <SettingsGroup header={`${runtime.label} models`}><SettingsRow label="Model selection" subtitle="Choose supported models in the workspace composer. Provider-managed model settings stay with the provider." /></SettingsGroup>}
    {runtimeId === 'claude-code' ? <>
      <ClaudeCodeHarnessSection />
      {data ? <SettingsGroup header="Claude fallback model"><SettingsRow label="Claude fallback model" subtitle={data.sources.orchestratorModel === 'env' ? ENV_LOCKED_REASON : 'Used only when a request does not select a model.'} accessory={
        <PickerMenu<string> value={data.values.orchestratorModel} options={ORCHESTRATOR_MODEL_OPTIONS} onChange={value => { updateField('orchestratorModel', value); }} disabled={data.sources.orchestratorModel === 'env' || busyField !== null} minWidth={150} />
      } /></SettingsGroup> : null}
    </> : null}
    <SettingsGroup header={`${runtime.label} environment`}><SettingsRow label="Runtime configuration" subtitle="Managed by this CLI. App keys and Local ACP launch settings are in the provider list." /></SettingsGroup>
    {['codex', 'claude-code', 'cursor'].includes(runtimeId) ? <ProviderUsageSection runtimeId={runtimeId} label={runtimeId === 'codex' ? 'ChatGPT / Codex' : runtime.label} /> : null}
  </div>;
}
