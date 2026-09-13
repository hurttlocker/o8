'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode, type Ref } from 'react';
import { ComposerPicker } from './ComposerPicker';
import { ModeChip } from './ModeChip';
import {
  readComposerEffortMaps,
  resolveComposerLeadCatalogueLabel,
  resolveComposerSelectorState,
  resolveSupportedEffortChange,
  writeComposerModelEffort,
  type ComposerEffortClampNotice,
  type ComposerSelectorMode,
} from './state';
import {
  FALLBACK_DISPATCH_DEFAULTS,
  shortWorkerModelLabel,
  workerModelForDisplay,
  type DispatchDefaults,
} from '../ComposerFleetChips';
import type { OrchestratorBackendSetting } from '../operator-defaults';
import { fetchOperatorDefaultsValues, invalidateOperatorDefaultsValuesSnapshot } from '@/lib/operator/operator-defaults-values-client';
import { getRuntimeCapability, type OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { WorkerStartMode } from '@/lib/operator/worker-start-mode';
import { useComposerModelCatalogue } from '../ModelThinkingChip';
import { parseLocalModel } from '@/lib/codex/local-model';
import { formatModelLabel } from '@/lib/format';
import { useUltraEffortPreference } from './UltraEffortPreference';

export function ComposerSelectorFooter({
  mode,
  onModeChange,
  modelId,
  modelLabel,
  activeBackend,
  onModelChange,
  onBackendChange,
  effort,
  onEffortChange,
  adaptiveEnabled,
  operatorDefaultEffort = effort,
  clampNotice = null,
  isFreePlan = false,
  threadId = null,
  leadingControls,
  attachControl,
  meterControl,
  micControl,
  voiceControl,
  sendControl,
  containerRef,
  onRequestTextareaFocus,
}: {
  input: string;
  mode: ComposerSelectorMode;
  onModeChange: (mode: ComposerSelectorMode) => void;
  modelId: string;
  modelLabel: string;
  activeBackend: OrchestratorBackendSetting;
  onModelChange?: (model: string) => void;
  onBackendChange?: (backend: OrchestratorBackendSetting, model?: string) => void;
  effort: ThinkingEffort;
  onEffortChange: (effort: ThinkingEffort) => void;
  adaptiveEnabled: boolean;
  operatorDefaultEffort?: ThinkingEffort;
  clampNotice?: ComposerEffortClampNotice | null;
  isFreePlan?: boolean;
  threadId?: string | null;
  leadingControls?: ReactNode;
  attachControl?: ReactNode;
  meterControl?: ReactNode;
  micControl?: ReactNode;
  voiceControl?: ReactNode;
  sendControl?: ReactNode;
  containerRef?: Ref<HTMLDivElement>;
  onRequestTextareaFocus?: () => void;
}) {
  const [defaults, setDefaults] = useState<DispatchDefaults>(FALLBACK_DISPATCH_DEFAULTS);
  const [threadEfforts, setThreadEfforts] = useState(() => readComposerEffortMaps(threadId, modelId).thread);
  const [saving, setSaving] = useState(false);
  const ultraEnabled = useUltraEffortPreference();
  const { groups: baseComposerModelGroups } = useComposerModelCatalogue();
  const localLead = useMemo(() => activeBackend === 'codex' ? parseLocalModel(modelId) : null, [activeBackend, modelId]);
  const composerModelGroups = useMemo(() => {
    if (!localLead || baseComposerModelGroups.some((group) => group.options.some((option) => (option.model ?? option.value) === modelId))) {
      return baseComposerModelGroups;
    }
    return baseComposerModelGroups.map((group) => group.key === 'codex' ? {
      ...group,
      options: [{ value: modelId, label: formatModelLabel(localLead.model), backend: 'codex' as const, model: modelId, sub: `${localLead.provider} · local` }, ...group.options],
    } : group);
  }, [baseComposerModelGroups, localLead, modelId]);
  const resolvedModelLabel = resolveComposerLeadCatalogueLabel(
    activeBackend,
    modelId,
    modelLabel,
    composerModelGroups.flatMap((group) => group.options),
  );

  const refetchDefaults = useCallback(async () => {
    try {
      const response = await fetchOperatorDefaultsValues();
      if (!response.ok) return;
      const payload = await response.json() as { values?: Partial<DispatchDefaults> };
      const values = payload.values ?? {};
      setDefaults({
        defaultDispatchRuntime: (values.defaultDispatchRuntime as OrchestratorRuntime) || 'codex',
        defaultDispatchModel: typeof values.defaultDispatchModel === 'string' ? values.defaultDispatchModel : '',
        opencodeWorkerModel: typeof values.opencodeWorkerModel === 'string' && values.opencodeWorkerModel ? values.opencodeWorkerModel : null,
        workerStartMode: values.workerStartMode === 'huddle' || values.workerStartMode === 'adaptive' ? values.workerStartMode : 'autonomous',
      });
    } catch {
      // Keep the last confirmed operator defaults.
    }
  }, []);

  useEffect(() => { void refetchDefaults(); }, [refetchDefaults]);
  useEffect(() => {
    setThreadEfforts(readComposerEffortMaps(threadId, modelId).thread);
  }, [modelId, threadId]);

  const runtimeLabel = getRuntimeCapability(defaults.defaultDispatchRuntime).label;
  const workerModel = workerModelForDisplay(defaults.defaultDispatchRuntime, defaults);
  const resolved = useMemo(() => resolveComposerSelectorState({
    mode,
    leadModelId: modelId,
    leadModelLabel: resolvedModelLabel,
    leadBackend: activeBackend,
    inSessionEffortByModel: { [modelId]: effort },
    threadEffortByModel: threadEfforts,
    operatorDefaultEffort,
    adaptiveEnabled,
    ultraEnabled,
    isFreePlan,
    workerRuntimeLabel: runtimeLabel,
    workerModelLabel: workerModel ? shortWorkerModelLabel(workerModel) : null,
    clampNotice,
  }), [activeBackend, adaptiveEnabled, clampNotice, effort, isFreePlan, mode, modelId, operatorDefaultEffort, resolvedModelLabel, runtimeLabel, threadEfforts, ultraEnabled, workerModel]);

  const setEffort = (next: ThinkingEffort) => {
    const change = resolveSupportedEffortChange(next, resolved.effort, resolved.effortOptions);
    if (!change.accepted) {
      if (effort !== change.effort) onEffortChange(change.effort);
      return;
    }
    if (change.effort === effort) return;
    writeComposerModelEffort(modelId, change.effort, threadId);
    setThreadEfforts((current) => ({ ...current, [modelId]: change.effort }));
    onEffortChange(change.effort);
  };

  const persistDefaults = useCallback(async (patch: Partial<DispatchDefaults>) => {
    setDefaults((current) => ({ ...current, ...patch }));
    setSaving(true);
    try {
      await fetch('/api/panel/operator-defaults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      invalidateOperatorDefaultsValuesSnapshot();
    } catch {
      // The confirmed read below restores server truth after a failed write.
    } finally {
      await refetchDefaults();
      setSaving(false);
    }
  }, [refetchDefaults]);

  return (
    <div
      ref={containerRef}
      data-testid="composer-selector-footer"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minHeight: 36,
        paddingTop: 4,
        paddingRight: 8,
        paddingBottom: 8,
        paddingLeft: 8,
      }}
    >
      <ModeChip state={resolved} onModeChange={onModeChange} />
      <span data-testid="composer-selector-attach" style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{attachControl}</span>
      {leadingControls ? (
        <span data-testid="composer-selector-leading-controls" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' }}>
          {leadingControls}
        </span>
      ) : null}
      <span data-testid="composer-selector-spacer" style={{ flex: 1, minWidth: 0 }} />
      {meterControl ? (
        <span data-testid="composer-selector-meter" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {meterControl}
        </span>
      ) : null}
      <ComposerPicker
        state={resolved}
        defaults={defaults}
        composerModelGroups={composerModelGroups}
        onModelChange={onModelChange}
        onBackendChange={onBackendChange}
        onEffortChange={setEffort}
        onRuntimeChange={(defaultDispatchRuntime) => { void persistDefaults({ defaultDispatchRuntime }); }}
        onWorkerModelChange={(opencodeWorkerModel) => { void persistDefaults({ opencodeWorkerModel }); }}
        onWorkerStartModeChange={(workerStartMode: WorkerStartMode) => { void persistDefaults({ workerStartMode }); }}
        onRequestTextareaFocus={onRequestTextareaFocus}
        saving={saving}
      />
      <span data-testid="composer-selector-mic" style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{micControl}</span>
      {voiceControl ? <span data-testid="composer-selector-voice" style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{voiceControl}</span> : null}
      <span data-testid="composer-selector-send" style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{sendControl}</span>
    </div>
  );
}
