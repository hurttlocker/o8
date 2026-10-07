'use client';

import { OnboardingFeedback } from './OnboardingFeedback';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import {
  PickerMenu,
  type DispatchRuntime,
} from '@/components/desktop/settings/dispatch-shared';
import {
  canSelectOnboardingRuntime,
  loadOnboardingRuntimeSelection,
  persistOnboardingRuntimeSelection,
  toggleOnboardingWorkerRuntime,
  type DispatchableRuntimeInventoryItem,
  type OnboardingOrchestratorRuntime,
} from './onboarding-runtime-selection';
import type { OnboardingRequest } from './request';
import { RuntimeToolsPanel } from './RuntimeToolsPanel';
import { AgentReadiness } from './AgentReadiness';
import { useToolScanStatus } from './useToolScanStatus';
import { onboardingQuietButtonStyle } from './onboarding-style';
import { formatModelLabel } from '@/lib/format';
import { leadModelPreset, runtimeForLead, visibleRuntimeInventory, workerModelPreset } from '@/lib/setup/runtime-recommendation';
import { orchestratorBackendForRuntime, type OnboardingRuntimeSelection } from './onboarding-runtime-selection';

const FONT = 'var(--font-sans-system)';

const ORCHESTRATOR_LABELS: Partial<Record<OnboardingOrchestratorRuntime, string>> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  fable: 'Fable',
  opencode: 'OpenCode · experimental',
  o8: 'o8',
  auto: 'Saved automatic routing',
};

function CheckGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function RuntimeInventoryRow({
  runtime,
  selected,
  isDefault,
  onToggle,
  disabled,
}: {
  runtime: DispatchableRuntimeInventoryItem;
  selected: boolean;
  isDefault: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  const selectable = runtime.available;
  return (
    <button
      type="button"
      disabled={disabled || (!selectable && !selected)}
      aria-pressed={selected}
      onClick={onToggle}
      style={{
        width: '100%',
        minHeight: 58,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        paddingTop: 9,
        paddingBottom: 9,
        paddingLeft: 12,
        paddingRight: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: selected ? 'var(--t-accent)' : 'var(--t-glass-border-strong)',
        borderRadius: 10,
        background: selected ? 'var(--t-input-bg)' : 'var(--t-bg-card)',
        color: 'var(--t-text)',
        fontFamily: FONT,
        textAlign: 'left',
        cursor: selectable ? 'pointer' : 'not-allowed',
        opacity: selectable ? 1 : 0.52,
        transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>
            {runtime.label}
          </span>
          {isDefault ? (
            <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t-accent)' }}>
              Default worker
            </span>
          ) : null}
        </span>
        <span style={{ fontSize: 10.5, fontWeight: 300, lineHeight: 1.35, color: 'var(--t-text-muted)' }}>
          {selectable ? runtime.detail : runtime.fix || runtime.detail}
        </span>
      </span>
      <span style={{
        width: 24,
        height: 24,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 7,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: selected ? 'var(--t-accent)' : 'var(--t-glass-border-strong)',
        background: selected ? 'var(--t-accent)' : 'transparent',
        color: selected ? 'var(--t-success-contrast)' : 'var(--t-text-faint)',
      }}>
        {selected ? <CheckGlyph /> : null}
      </span>
    </button>
  );
}

export const OnboardingDispatchStep = memo(function OnboardingDispatchStep({
  request = fetch, onContinue, onSkip, renderButton, onBusyChange,
}: {
  request?: OnboardingRequest;
  onContinue: () => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  onSkip: () => void;
  renderButton: (props: { label: string; onClick: () => void; disabled?: boolean }) => ReactNode;
}) {
  const [selection, setSelection] = useState<OnboardingRuntimeSelection | null>(null);
  const [orchestratorRuntime, setOrchestratorRuntime] = useState<OnboardingOrchestratorRuntime>('codex');
  const [workerRuntimes, setWorkerRuntimes] = useState<DispatchRuntime[]>([]);
  const [customize, setCustomize] = useState(false);
  const [loading, setLoading] = useState(true);
  const scanStatus = useToolScanStatus(loading);
  const [saving, setSaving] = useState(false);
  useEffect(() => { onBusyChange?.(saving); return () => onBusyChange?.(false); }, [onBusyChange, saving]);
  const [error, setError] = useState<string | null>(null);
  const choiceMade = useRef(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void loadOnboardingRuntimeSelection(request, revision > 0).then((next) => {
      if (!active) return;
      setSelection((previous) => choiceMade.current && previous
        ? { ...previous, inventory: next.inventory, sources: next.sources } : next);
      // A rescan can finish initial setup, but never replace a choice.
      if (revision === 0 || !choiceMade.current) {
        setOrchestratorRuntime(next.orchestratorRuntime);
        setWorkerRuntimes(next.workerRuntimes);
      }
    }).catch((cause: unknown) => {
      if (active) { setSelection(null); setError(cause instanceof Error ? cause.message : 'Runtime inventory is unavailable.'); }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request, revision]);

  const inventory = selection?.inventory ?? [];
  const backend = orchestratorBackendForRuntime(orchestratorRuntime);
  const leadRuntime = runtimeForLead(backend);
  const locked = selection?.sources.orchestratorBackend === 'env' || selection?.sources.orchestratorBackend === 'profile';
  const workersLocked = selection?.sources.defaultDispatchRuntime === 'env' || selection?.sources.defaultDispatchRuntime === 'profile';
  const sameLead = selection?.orchestratorRuntime === orchestratorRuntime;
  const leadModel = sameLead ? selection?.recommendation.leadModel ?? '' : leadModelPreset(backend);
  const workerModel = workerRuntimes[0] === selection?.workerRuntimes[0]
    ? selection?.recommendation.workerModel ?? '' : workerRuntimes[0] === 'opencode' ? selection?.recommendation.opencodeModel ?? workerModelPreset('opencode') : workerModelPreset(workerRuntimes[0]);
  const leadReady = leadRuntime ? canSelectOnboardingRuntime(inventory, leadRuntime)
    : backend === 'o8' || Boolean(sameLead && selection?.recommendation.preserved);
  const readyToSave = Boolean(selection && leadReady && workerRuntimes.length > 0
    && workerRuntimes.every((id) => canSelectOnboardingRuntime(inventory, id)));
  const leadOptions = (['codex', 'claude-code', ...(customize ? ['fable', 'opencode', 'o8'] : [])] as OnboardingOrchestratorRuntime[])
    .filter((id) => id === 'o8' || inventory.some((item) => item.id === runtimeForLead(orchestratorBackendForRuntime(id)) && item.available));
  if ((selection?.recommendation.preserved || choiceMade.current) && !leadOptions.includes(orchestratorRuntime)) leadOptions.push(orchestratorRuntime);
  const options = leadOptions.map((value) => ({ value, label: ORCHESTRATOR_LABELS[value] ?? value }));
  const needsConnection = !loading && options.length === 0;
  const shownWorkers = visibleRuntimeInventory(inventory, workerRuntimes);

  const handleContinue = useCallback(async () => {
    if (!readyToSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      await persistOnboardingRuntimeSelection({ orchestratorRuntime, workerRuntimes, leadModel, workerModel }, request);
      await onContinue();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save your setup.');
    } finally { setSaving(false); }
  }, [readyToSave, saving, orchestratorRuntime, workerRuntimes, leadModel, workerModel, request, onContinue]);

  const changeLead = (next: OnboardingOrchestratorRuntime) => {
    choiceMade.current = true;
    setOrchestratorRuntime(next);
    if (!selection?.recommendation.preserved && !workersLocked && !customize && (!selection?.sources.defaultDispatchRuntime || selection.sources.defaultDispatchRuntime === 'default') && (!selection?.sources.workerRuntimes || selection.sources.workerRuntimes === 'default')) {
      const nextRuntime = runtimeForLead(orchestratorBackendForRuntime(next));
      if (nextRuntime && canSelectOnboardingRuntime(inventory, nextRuntime)) setWorkerRuntimes([nextRuntime]);
    }
  };
  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 16, fontFamily: FONT }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 300, color: 'var(--t-text)' }}>{needsConnection ? 'Connect a coding tool' : 'Choose your agent'}</h1>
        <p style={{ marginTop: 12, marginBottom: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--t-text-secondary)' }}>Start with one coding tool. You can add more and adjust your setup later.</p>
      </div>
      {loading ? <div role="status" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>{scanStatus}</div> : <>
        <AgentReadiness inventory={inventory.filter((item) => item.id === 'codex' || item.id === 'claude-code' || item.id === leadRuntime)} selectedRuntime={leadRuntime} disabled={saving || locked} onSelect={(item) => changeLead(item.id as OnboardingOrchestratorRuntime)} />
        <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>
          Selected agent: {ORCHESTRATOR_LABELS[orchestratorRuntime] ?? orchestratorRuntime}.
          {sameLead ? <div style={{ marginTop: 4 }}>{selection?.recommendation.reason}</div> : null}
        </div>
      </>}
      <button type="button" aria-expanded={customize} onClick={() => setCustomize((current) => !current)} style={{ ...onboardingQuietButtonStyle, alignSelf: 'flex-start', paddingLeft: 0, color: 'var(--t-accent)', fontSize: 12 }}>
        {customize ? 'Keep it simple' : 'Customize'}
      </button>
      {customize ? <div style={{ border: '1px solid var(--t-glass-border-strong)', borderRadius: 12, padding: 16, background: 'var(--t-bg-card)', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 300, color: 'var(--t-text)' }}>
            Lead
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--t-text-muted)' }}>{leadModel ? formatModelLabel(leadModel) : 'Uses the configured model'}</div>
          </div>
          <PickerMenu<OnboardingOrchestratorRuntime> value={orchestratorRuntime} options={options} onChange={changeLead} disabled={loading || saving || locked || !options.length} minWidth={180} />
        </div>
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--t-text-secondary)' }}>Your lead plans the work, assigns tasks, and checks the result. Workers handle the tasks it delegates. You can change either later.</p>
        {locked ? <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Your environment or subscription profile controls the lead. Change that in Settings to use another tool.</div> : null}
        <div style={{ fontSize: 13, fontWeight: 300, color: 'var(--t-text)' }}>
          Workers: {workerRuntimes.map((id) => inventory.find((item) => item.id === id)?.label ?? id).join(', ') || 'Connect a tool'}
          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--t-text-muted)' }}>{workerModel ? formatModelLabel(workerModel) : 'Uses each tool’s configured model'}</div>
        </div>
      </div> : null}
      {customize ? <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Choose the tools allowed to receive work. The first selected tool is the default worker. OpenCode starts with its detected configuration or a supported preset; choose another model in the composer.</div>
        {shownWorkers.map((item) => <RuntimeInventoryRow key={item.id} runtime={item} selected={workerRuntimes.includes(item.id)} isDefault={workerRuntimes[0] === item.id} disabled={saving || workersLocked || loading} onToggle={() => {
          choiceMade.current = true;
          if (!saving && !workersLocked) setWorkerRuntimes((current) => toggleOnboardingWorkerRuntime(current, item.id, inventory));
        }} />)}
      </div> : null}
      {!loading && !leadReady && !needsConnection ? <div style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>Connect a primary lead, or customize to choose a supported alternative.</div> : null}
      {!loading && !readyToSave && workerRuntimes.length > 0 ? <div style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>Some selected tools need attention. Connect them below or customize your setup.</div> : null}
      {error ? <OnboardingFeedback tone="error" title={error}>Your selections are still here. Try saving again when you’re ready.</OnboardingFeedback> : null}
      <RuntimeToolsPanel key={needsConnection ? 'connect' : 'additional'} initiallyExpanded={needsConnection} inventory={needsConnection ? inventory.filter((item) => item.id === 'codex' || item.id === 'claude-code') : inventory} loading={loading} error={null} onRefresh={() => setRevision((current) => current + 1)} />
      {!needsConnection ? <div style={{ fontSize: 10.5, lineHeight: 1.4, color: 'var(--t-text-faint)' }}>Recommendations use session file activity from the past seven days. Conversation contents stay unread. Messaging and other optional features can be connected later.</div> : null}
      <div style={{ position: 'sticky', bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, paddingTop: 12, paddingBottom: 12, background: 'var(--t-onboarding-bg)', borderTop: '1px solid var(--t-divider)' }}>
        <button type="button" disabled={saving} onClick={onSkip} style={{ border: 0, background: 'transparent', color: 'var(--t-text-faint)', fontFamily: FONT, fontSize: 12, fontWeight: 300, minHeight: 44, cursor: 'pointer', padding: 8 }}>Set up later</button>
        {renderButton({ label: saving ? 'Saving setup…' : 'Use this setup', onClick: handleContinue, disabled: loading || saving || !readyToSave })}
      </div>
    </div>
  );
});
