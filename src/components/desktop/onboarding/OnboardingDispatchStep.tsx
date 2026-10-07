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
  loadOnboardingBuiltInAgent,
  persistOnboardingRuntimeSelection,
  toggleOnboardingWorkerRuntime,
  type DispatchableRuntimeInventoryItem,
  type OnboardingOrchestratorRuntime,
} from './onboarding-runtime-selection';
import type { OnboardingRequest } from './request';
import { OnboardingToolsPanel } from './OnboardingToolsPanel';
import { AgentReadiness } from './AgentReadiness';
import { useToolScanStatus } from './useToolScanStatus';
import { onboardingButtonStyle, onboardingQuietButtonStyle } from './onboarding-style';
import { Plus, RefreshCw, SlidersHorizontal } from '../lucide-shims';
import { RuntimeIdentity } from './RuntimeIdentity';
import { formatModelLabel } from '@/lib/format';
import { leadModelPreset, runtimeForLead, visibleRuntimeInventory, workerModelPreset } from '@/lib/setup/runtime-recommendation';
import { orchestratorBackendForRuntime, type OnboardingRuntimeSelection } from './onboarding-runtime-selection';
import { builtInAgentFromInventory, setupRuntimeLabel } from '@/lib/setup/built-in-agent';
import type { SetupRuntime } from '@/lib/setup/runtime-recommendation';

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
      <RuntimeIdentity runtime={runtime.id} builtIn={Boolean(runtime.builtIn)} />
      <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
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
          {runtime.builtIn ? <span style={{ display: 'block', marginTop: 4 }}>{runtime.builtIn.planDetail}</span> : null}
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
  const [initialBuiltIn, setInitialBuiltIn] = useState<SetupRuntime | null>(null);
  const [orchestratorRuntime, setOrchestratorRuntime] = useState<OnboardingOrchestratorRuntime>('codex');
  const [workerRuntimes, setWorkerRuntimes] = useState<DispatchRuntime[]>([]);
  const [panel, setPanel] = useState<'choose' | 'customize' | 'tools' | null>(null);
  const customize = panel === 'customize';
  const headingRef = useRef<HTMLHeadingElement>(null);
  const toolsButtonRef = useRef<HTMLButtonElement>(null);
  const customizeButtonRef = useRef<HTMLButtonElement>(null);
  const previousPanel = useRef(panel);
  useEffect(() => {
    if (panel === 'tools' || panel === 'customize') headingRef.current?.focus();
    else if (previousPanel.current === 'tools') toolsButtonRef.current?.focus();
    else if (previousPanel.current === 'customize') customizeButtonRef.current?.focus();
    previousPanel.current = panel;
  }, [panel]);
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
    void loadOnboardingBuiltInAgent(request).then((next) => { if (active) setInitialBuiltIn(next); }).catch(() => {});
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
  const leadRuntime = runtimeForLead(backend, inventory);
  const builtIn = builtInAgentFromInventory(inventory);
  const builtInChoice = builtIn?.builtIn?.backend === 'claude' ? 'claude-code' : builtIn?.builtIn?.backend;
  const leadLabel = setupRuntimeLabel(backend, inventory) ?? ORCHESTRATOR_LABELS[orchestratorRuntime] ?? orchestratorRuntime;
  const locked = selection?.sources.orchestratorBackend === 'env' || selection?.sources.orchestratorBackend === 'profile';
  const workersLocked = selection?.sources.defaultDispatchRuntime === 'env' || selection?.sources.defaultDispatchRuntime === 'profile';
  const sameLead = selection?.orchestratorRuntime === orchestratorRuntime;
  const leadModel = sameLead ? selection?.recommendation.leadModel ?? '' : leadModelPreset(backend);
  const workerModel = workerRuntimes[0] === selection?.workerRuntimes[0]
    ? selection?.recommendation.workerModel ?? '' : workerRuntimes[0] === builtIn?.id ? '' : workerRuntimes[0] === 'opencode' ? selection?.recommendation.opencodeModel ?? workerModelPreset('opencode') : workerModelPreset(workerRuntimes[0]);
  const leadReady = leadRuntime ? canSelectOnboardingRuntime(inventory, leadRuntime)
    : backend === 'o8' || Boolean(sameLead && selection?.recommendation.preserved);
  const readyToSave = Boolean(selection && leadReady && workerRuntimes.length > 0
    && workerRuntimes.every((id) => canSelectOnboardingRuntime(inventory, id)));
  const leadOptions = (['codex', 'claude-code', ...(customize ? ['fable', 'opencode', 'o8'] : [])] as OnboardingOrchestratorRuntime[])
    .filter((id) => id === 'o8' || inventory.some((item) => item.id === runtimeForLead(orchestratorBackendForRuntime(id)) && item.available));
  if (builtIn?.available && builtInChoice && !leadOptions.includes(builtInChoice)) leadOptions.unshift(builtInChoice);
  if ((selection?.recommendation.preserved || choiceMade.current) && !leadOptions.includes(orchestratorRuntime)) leadOptions.push(orchestratorRuntime);
  const options = leadOptions.map((value) => ({ value, label: setupRuntimeLabel(orchestratorBackendForRuntime(value), inventory) ?? ORCHESTRATOR_LABELS[value] ?? value }));
  const needsConnection = Boolean(selection && options.length === 0 && !builtIn);
  const showTools = panel === 'tools' || (needsConnection && panel === null);
  const shownWorkers = visibleRuntimeInventory(inventory, workerRuntimes);
  const commonInventory = builtIn?.available ? visibleRuntimeInventory(inventory, leadRuntime ? [leadRuntime] : []) : inventory;
  const commonChoices = commonInventory.filter((item) => item.id === 'codex' || item.id === 'claude-code' || item.id === leadRuntime);
  // TODO(#3273): an existing Pi setup is a separate choice from the bundled agent.
  const readyChoices = builtIn ? [builtIn, ...commonChoices.filter((item) => item.id !== builtIn.id)]
    : !selection && initialBuiltIn ? [initialBuiltIn] : commonChoices;

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
      const nextRuntime = runtimeForLead(orchestratorBackendForRuntime(next), inventory);
      if (nextRuntime && canSelectOnboardingRuntime(inventory, nextRuntime)) setWorkerRuntimes([nextRuntime]);
    }
  };
  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 16, fontFamily: FONT }}>
      <div>
        <h1 ref={headingRef} tabIndex={-1} style={{ margin: 0, fontSize: 28, fontWeight: 300, color: 'var(--t-text)', outline: 'none' }}>{showTools ? needsConnection ? 'Connect a coding tool' : 'Add coding tools' : customize ? 'Customize your setup' : 'Choose your agent'}</h1>
        <p style={{ marginTop: 12, marginBottom: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--t-text-secondary)' }}>{showTools ? 'Install or sign in to a tool, then refresh to check it. Your selected setup stays yours.' : customize ? 'Choose the lead and workers for this project. Save when your setup is ready.' : 'Start with an agent. You can add coding tools and adjust your setup later.'}</p>
      </div>
      {showTools ? <OnboardingToolsPanel inventory={inventory.filter((item) => !item.builtIn && (!needsConnection || item.id === 'codex' || item.id === 'claude-code'))} loading={loading} disabled={saving} /> : <>
        {!customize ? <>
          <AgentReadiness inventory={readyChoices} selectedRuntime={leadRuntime} disabled={loading || saving || locked} onSelect={(item) => changeLead(item.builtIn ? item.builtIn.backend === 'claude' ? 'claude-code' : item.builtIn.backend : item.id as OnboardingOrchestratorRuntime)} />
          {loading ? <div role="status" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>{scanStatus}</div> : <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>
            Selected agent: {leadLabel}.
            {sameLead ? <div style={{ marginTop: 4 }}>{selection?.recommendation.reason}</div> : null}
          </div>}
        </> : null}
        <div aria-label="Optional setup actions" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button ref={customizeButtonRef} type="button" disabled={loading || saving} aria-expanded={customize} aria-controls="onboarding-customization" onClick={() => setPanel(customize ? 'choose' : 'customize')} style={{ ...onboardingButtonStyle, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <SlidersHorizontal size={14} aria-hidden="true" />{customize ? 'Done customizing' : 'Customize setup'}
          </button>
          <button ref={toolsButtonRef} type="button" disabled={loading || saving} aria-expanded={false} aria-controls="onboarding-tool-setup" onClick={() => setPanel('tools')} style={{ ...onboardingButtonStyle, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Plus size={14} aria-hidden="true" />Add coding tools
          </button>
        </div>
        {customize ? <section id="onboarding-customization" aria-label="Setup customization" style={{ maxHeight: 'clamp(180px, calc(100dvh - 480px), 440px)', overflowY: 'auto', border: '1px solid var(--t-divider)', borderRadius: 12, padding: 16, background: 'var(--t-bg-card)', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 300, color: 'var(--t-text)' }}>
              Lead
              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--t-text-muted)' }}>{leadRuntime === builtIn?.id ? builtIn?.builtIn?.planDetail : leadModel ? formatModelLabel(leadModel) : 'Uses the configured model'}</div>
            </div>
            <PickerMenu<OnboardingOrchestratorRuntime> value={orchestratorRuntime} options={options} onChange={changeLead} disabled={loading || saving || locked || !options.length} minWidth={180} />
          </div>
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--t-text-secondary)' }}>Your lead plans the work, assigns tasks, and checks the result. Workers handle the tasks it delegates. You can change either later.</p>
          {locked ? <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Your environment or subscription profile controls the lead. Change that in Settings to use another tool.</div> : null}
          <div style={{ fontSize: 13, fontWeight: 300, color: 'var(--t-text)' }}>
            Workers: {workerRuntimes.map((id) => inventory.find((item) => item.id === id)?.label ?? id).join(', ') || 'Connect a tool'}
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--t-text-muted)' }}>{workerRuntimes[0] === builtIn?.id ? builtIn?.builtIn?.planDetail : workerModel ? formatModelLabel(workerModel) : 'Uses each tool’s configured model'}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>Choose the tools allowed to receive work. The first selected tool is the default worker. OpenCode starts with its detected configuration or a supported preset; choose another model in the composer.</div>
            {shownWorkers.map((item) => <RuntimeInventoryRow key={item.id} runtime={item} selected={workerRuntimes.includes(item.id)} isDefault={workerRuntimes[0] === item.id} disabled={saving || workersLocked || loading} onToggle={() => {
              choiceMade.current = true;
              if (!saving && !workersLocked) setWorkerRuntimes((current) => toggleOnboardingWorkerRuntime(current, item.id, inventory));
            }} />)}
          </div>
        </section> : null}
      </>}
      {!loading && !leadReady && !needsConnection ? <div style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>Connect a primary lead, or customize to choose a supported alternative.</div> : null}
      {!loading && !readyToSave && workerRuntimes.length > 0 ? <div style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>Some selected tools need attention. Add coding tools or customize your setup.</div> : null}
      {error ? <OnboardingFeedback tone="error" title={error}>Your selections are still here. Try saving again when you’re ready.</OnboardingFeedback> : null}
      {!showTools ? <div style={{ fontSize: 10.5, lineHeight: 1.4, color: 'var(--t-text-faint)' }}>{leadRuntime !== builtIn?.id ? 'Recommendations use session file activity from the past seven days. Conversation contents stay unread. ' : ''}Messaging and other optional features can be connected later.</div> : null}
      <div style={{ position: 'sticky', bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, paddingTop: 12, paddingBottom: 12, background: 'var(--t-onboarding-bg)', borderTop: '1px solid var(--t-divider)' }}>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
          {showTools ? <button type="button" disabled={saving} onClick={() => setPanel('choose')} style={{ ...onboardingQuietButtonStyle, fontSize: 12 }}>Back to agent choices</button> : null}
          <button type="button" disabled={saving} onClick={onSkip} style={{ ...onboardingQuietButtonStyle, color: 'var(--t-text-faint)', fontSize: 12 }}>Set up later</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}>
          {showTools ? <button type="button" disabled={loading || saving} onClick={() => setRevision((current) => current + 1)} style={{ ...onboardingButtonStyle, display: 'inline-flex', alignItems: 'center', gap: 8 }}><RefreshCw size={14} aria-hidden="true" />{loading ? 'Checking tools…' : 'Refresh tools'}</button> : null}
          {renderButton({ label: saving ? 'Saving setup…' : 'Use this setup', onClick: handleContinue, disabled: loading || saving || !readyToSave })}
        </div>
      </div>
    </div>
  );
});
