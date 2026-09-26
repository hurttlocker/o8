'use client';
import { useEffect, useState } from 'react';
import { useRuntimeInventory } from '../onboarding/useRuntimeInventory';
import { RuntimeToolsPanel } from '../onboarding/RuntimeToolsPanel';
import { AcpModelPickerPopover } from './AcpModelPickerPopover';
import { SettingsAdvanced } from './SettingsAdvanced';
import { SettingsSegmented } from './shared';
import { SettingsGroup, SettingsRow } from './grouped';
import { PickerMenu, SUBSCRIPTION_PROFILE_OPTIONS, DISPATCH_RUNTIME_OPTIONS, ENV_LOCKED_REASON, resolvePickerGroupOpen,
  type CollideAggregator, type OperatorDefaults, type OperatorDefaultsResponse, type OrchestratorBackendSetting, type ReviewerBackendSetting, type SubscriptionProfile, type DispatchRuntime } from './dispatch-shared';
const DEFAULT_WORKER_RUNTIME_OPTIONS = DISPATCH_RUNTIME_OPTIONS;
type ExecutionCarrierSelection = 'direct' | 'ori';
const EXECUTION_CARRIER_OPTIONS: Array<{ value: ExecutionCarrierSelection; label: string; detail: string }> = [
  { value: 'direct', label: 'Direct', detail: 'Launch the selected runtime CLI directly.' },
  { value: 'ori', label: 'Via Ori', detail: 'Use Ori credentials and routing while Codex keeps session ownership.' },
];

type CliHouseStatus = NonNullable<OperatorDefaultsResponse['cliAuth']>['statuses']['codex'];

function cliStatusLabel(status: CliHouseStatus | undefined) {
  if (!status?.installed) return 'not installed';
  // Only a definite refusal reads as "not signed in". A house that is usable without
  // native credential evidence — inconclusive probe, or a non-native Claude carrier —
  // is reported as usable rather than accused of being signed out.
  if (!status.ready) return 'not signed in';
  if (!status.authenticated) return 'installed + usable';
  return 'installed + signed in';
}

function CpuIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" />
      <line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" />
      <line x1="15" y1="20" x2="15" y2="23" />
      <line x1="20" y1="9" x2="23" y2="9" />
      <line x1="20" y1="14" x2="23" y2="14" />
      <line x1="1" y1="9" x2="4" y2="9" />
      <line x1="1" y1="14" x2="4" y2="14" />
    </svg>
  );
}

function RocketIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}
export function ModelRoutingControls({ data, busyField, updateField, advanced = false }: {
  advanced?: boolean;
  data: OperatorDefaultsResponse;
  busyField: keyof OperatorDefaults | null;
  updateField: <K extends keyof OperatorDefaults>(field: K, value: OperatorDefaults[K]) => void;
}) {
  const tools = useRuntimeInventory(!advanced);
  // Hermes (ACP backend) only appears in the backend picker when its binary is present.
  const [hermesAvailable, setHermesAvailable] = useState(false);
  const [opencodeAvailable, setOpencodeAvailable] = useState(false);
  useEffect(() => {
    if (advanced) return;
    let alive = true;
    fetch('/api/setup/orchestrator-backends')
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setHermesAvailable(Boolean(d?.hermes));
        setOpencodeAvailable(Boolean(d?.opencode));
      })
      .catch(() => { /* picker just omits Hermes */ });
    return () => { alive = false; };
  }, [advanced]);
  const [openDispatchPicker, setOpenDispatchPicker] = useState<string | null>(null);
  const { values, sources, cliAuth } = data;
  const envLocked = (field: keyof OperatorDefaults) => sources[field] === 'env';
  const lockedSub = (field: keyof OperatorDefaults, normal: string) => envLocked(field) ? ENV_LOCKED_REASON : normal;
  const activeProfile = values.subscriptionProfile;
  const profileOverrideReason = activeProfile === 'claude-only'
    ? 'Subscription profile is Claude only — this is pinned to Claude.'
    : activeProfile === 'codex-only'
      ? 'Subscription profile is Codex / OpenAI only — this is pinned to Codex.'
      : null;
  const dispatchDefaultSubtitle = (() => {
    if (profileOverrideReason) return profileOverrideReason;
    if (envLocked('defaultDispatchRuntime')) return ENV_LOCKED_REASON;
    if (sources.defaultDispatchRuntime !== 'default') {
      return 'Used when you say "dispatch" without naming a runtime';
    }
    return 'Used when a task does not specify a worker';
  })();
  const carrierCompatibilityReason = values.defaultDispatchRuntime === 'codex'
    ? null
    : 'Ori is available when the effective default worker is Codex.';


  return (<>
    {!advanced && <>
    <section style={{ marginTop: 28 }}>
      <SettingsGroup header="Orchestrator" footnote="The orchestrator is your lead: talk through ideas, plan work, and coordinate workers here. Claude + Codex uses both providers.">
          <SettingsRow
            icon={<CpuIcon />}
            label="Lead provider"
            subtitle={profileOverrideReason ?? lockedSub('orchestratorBackend', values.orchestratorBackend === 'auto' ? `Uses your existing setup (${values.inAppOrchestratorEnabled ? 'Claude' : 'Codex'}). Select a connected provider to choose the lead explicitly.` : 'Choose the provider that leads the conversation, plans work, and coordinates workers.')}
            accessory={
              <PickerMenu<string>
                value={values.orchestratorBackend}
                disabled={Boolean(profileOverrideReason) || envLocked('orchestratorBackend') || busyField === 'orchestratorBackend'}
                minWidth={170}
                onChange={(next) => { updateField('orchestratorBackend', next as OrchestratorBackendSetting); }}
                options={[
                  { value: 'auto', label: 'Use existing setup' },
                  { value: 'o8', label: 'o8' },
                  ...(tools.inventory?.some((item) => item.id === 'codex' && item.available) || values.orchestratorBackend === 'codex' ? [{ value: 'codex', label: 'Codex', detail: cliStatusLabel(cliAuth?.statuses.codex) }] : []),
                  ...(tools.inventory?.some((item) => item.id === 'claude-code' && item.available) || values.orchestratorBackend === 'claude' ? [{ value: 'claude', label: 'Claude', detail: cliStatusLabel(cliAuth?.statuses.claude) }] : []),
                  // OpenClaw hidden from the picker (Q ruling 2026-07-16, not
                  // one-click yet); shown only if it's already the selection so
                  // an existing choice stays visible + escapable.
                  ...(values.orchestratorBackend === 'openclaw' ? [{ value: 'openclaw', label: 'OpenClaw' }] : []),
                  ...(hermesAvailable || values.orchestratorBackend === 'hermes' ? [{ value: 'hermes', label: 'Hermes' }] : []),
                  // Shown when the binary is present, mirroring Hermes. Without
                  // this the composer could select opencode while Settings
                  // rendered no selected segment at all.
                  ...(opencodeAvailable || values.orchestratorBackend === 'opencode' ? [{ value: 'opencode', label: 'OpenCode · experimental' }] : []),
                  ...(cliAuth?.statuses.claude?.ready && tools.inventory?.some((item) => item.id === 'codex' && item.available) || values.orchestratorBackend === 'collide' ? [{ value: 'collide', label: 'Claude + Codex' }] : []),
                ]}
              />
            }
            disabled={Boolean(profileOverrideReason) || envLocked('orchestratorBackend') || busyField === 'orchestratorBackend'}
            divider
          />
          <SettingsRow
            icon={<CpuIcon />}
            label="Code review provider"
            subtitle={profileOverrideReason ?? lockedSub('reviewerBackend', 'Optionally choose a different provider to review completed changes. Same as lead uses your orchestrator provider.')}
            accessory={
              <SettingsSegmented
                value={values.reviewerBackend}
                onChange={(next) => { updateField('reviewerBackend', next as ReviewerBackendSetting); }}
                options={[
                  { value: 'follow', label: 'Same as lead' },
                  { value: 'claude', label: 'Claude' },
                  { value: 'codex', label: 'Codex' },
                ]}
              />
            }
            disabled={Boolean(profileOverrideReason) || envLocked('reviewerBackend') || busyField === 'reviewerBackend'}
            divider
          />
      </SettingsGroup>
    </section>
    <section style={{ marginTop: 28 }}>
      <SettingsGroup header="Workers" footnote="Choose which connected tools may run tasks and which one starts when no worker is specified. Worker effort is available under Connected tools.">
          <SettingsRow
            icon={<RocketIcon />}
            label="Subscription profile"
            subtitle={lockedSub('subscriptionProfile', SUBSCRIPTION_PROFILE_OPTIONS.find((opt) => opt.value === activeProfile)?.detail ?? 'Choose which connected tools may run tasks')}
            accessory={
              <PickerMenu<SubscriptionProfile>
                value={activeProfile}
                options={SUBSCRIPTION_PROFILE_OPTIONS}
                onChange={(next) => { updateField('subscriptionProfile', next); }}
                disabled={envLocked('subscriptionProfile') || busyField === 'subscriptionProfile'}
                minWidth={190}
                open={openDispatchPicker === 'subscription-profile'}
                onOpenChange={(open) => setOpenDispatchPicker((current) => resolvePickerGroupOpen(current, 'subscription-profile', open))}
              />
            }
            disabled={envLocked('subscriptionProfile') || busyField === 'subscriptionProfile'}
            divider
          />
          <SettingsRow
            icon={<RocketIcon />}
            label="Default worker"
            subtitle={dispatchDefaultSubtitle}
            accessory={
              <PickerMenu<DispatchRuntime>
                value={values.defaultDispatchRuntime}
                options={DEFAULT_WORKER_RUNTIME_OPTIONS.filter((option) => option.value === values.defaultDispatchRuntime || tools.inventory?.some((item) => item.id === option.value && item.available))}
                onChange={(next) => { updateField('defaultDispatchRuntime', next); }}
                disabled={Boolean(profileOverrideReason) || envLocked('defaultDispatchRuntime') || busyField === 'defaultDispatchRuntime'}
                minWidth={150}
                open={openDispatchPicker === 'default-worker'}
                onOpenChange={(open) => setOpenDispatchPicker((current) => resolvePickerGroupOpen(current, 'default-worker', open))}
              />
            }
            disabled={Boolean(profileOverrideReason) || envLocked('defaultDispatchRuntime') || busyField === 'defaultDispatchRuntime'}
            divider
          />
      </SettingsGroup>
    </section>
    <RuntimeToolsPanel inventory={tools.inventory} loading={tools.loading} error={tools.error} onRefresh={tools.refresh} />
    </>}
    {advanced && <>
    <SettingsAdvanced label="Advanced orchestrator options" description="Fallback models and behavior for combined or existing lead setups.">
      <SettingsGroup>
          <SettingsRow
            icon={<CpuIcon />}
            label="OpenCode fallback model"
            subtitle={lockedSub('opencodeOrchestratorModel', 'Used only when a request supplies no model. The composer’s selection takes precedence.')}
            accessory={
              <AcpModelPickerPopover
                label={values.opencodeOrchestratorModel ?? 'Choose'}
                value={values.opencodeOrchestratorModel}
                onSelect={(next) => { updateField('opencodeOrchestratorModel', next); }}
                onClear={() => { updateField('opencodeOrchestratorModel', null); }}
                disabled={envLocked('opencodeOrchestratorModel') || busyField === 'opencodeOrchestratorModel'}
              />
            }
            divider
          />
          <SettingsRow
            icon={<CpuIcon />}
            label="Combined answer provider"
            disabled={envLocked('collideAggregator') || busyField === 'collideAggregator'}
            subtitle={lockedSub('collideAggregator', 'Choose who combines the answers when the lead uses Claude + Codex.')}
            accessory={
              <SettingsSegmented
                value={values.collideAggregator}
                onChange={(next) => { updateField('collideAggregator', next as CollideAggregator); }}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'claude', label: 'Claude' },
                  { value: 'codex', label: 'Codex' },
                ]}
              />
            }
            divider
          />
          <SettingsRow
            icon={<CpuIcon />}
            label="Existing setup uses Claude"
            subtitle={lockedSub('inAppOrchestratorEnabled', 'Only affects Use existing setup: on uses Claude, off uses Codex. An explicit lead provider takes precedence.')}
            checked={values.inAppOrchestratorEnabled}
            disabled={envLocked('inAppOrchestratorEnabled') || busyField === 'inAppOrchestratorEnabled'}
            onToggle={(next) => { updateField('inAppOrchestratorEnabled', next); }}
            divider
          />
      </SettingsGroup>
    </SettingsAdvanced>
    <SettingsAdvanced label="Advanced worker setup" description="Optional local Codex launcher and switching providers after a usage limit.">
      <SettingsGroup>
          <SettingsRow
            icon={<RocketIcon />}
            label="Codex launch method"
            subtitle={carrierCompatibilityReason ?? 'Direct starts Codex normally. Ori wraps the local Codex CLI and supplies credentials and routing. Both tools must be installed; this does not move tasks to a cloud server.'}
            accessory={
              <PickerMenu<ExecutionCarrierSelection>
                value={values.workerExecutionCarrier ?? 'direct'}
                options={carrierCompatibilityReason ? EXECUTION_CARRIER_OPTIONS.slice(0, 1) : EXECUTION_CARRIER_OPTIONS}
                onChange={(next) => { updateField('workerExecutionCarrier', next === 'direct' ? null : next); }}
                disabled={busyField === 'workerExecutionCarrier'}
                minWidth={150}
                open={openDispatchPicker === 'execution-carrier'}
                onOpenChange={(open) => setOpenDispatchPicker((current) => resolvePickerGroupOpen(current, 'execution-carrier', open))}
              />
            }
            disabled={busyField === 'workerExecutionCarrier'}
          />
          <SettingsRow
            icon={<RocketIcon />}
            label="Worker quota fallback"
            subtitle={lockedSub('crossHouseWorkerFallback', 'Allow a task to restart with another supported subscription provider when its worker reaches a usage limit.')}
            checked={values.crossHouseWorkerFallback}
            disabled={envLocked('crossHouseWorkerFallback') || busyField === 'crossHouseWorkerFallback'}
            onToggle={(next) => { updateField('crossHouseWorkerFallback', next); }}
          />
      </SettingsGroup>
    </SettingsAdvanced>
    </>}
  </>);
}
