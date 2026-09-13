'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseLocalModel } from '@/lib/codex/local-model';
import { useEntitlement } from '@/lib/entitlement/context';
import { formatModelLabel } from '@/lib/format';
import {
  fetchOperatorDefaultsValues,
  updateOperatorDefaultsValues,
} from '@/lib/operator/operator-defaults-values-client';
import type { WorkerStartMode } from '@/lib/operator/worker-start-mode';
import type { OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import { readStoredOrchestratorModel, writeStoredOrchestratorModel } from '@/lib/orchestrator/store';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { useComposerModelCatalogue } from '../ModelThinkingChip';
import { readStoredComposerMode, writeStoredComposerMode } from '../composer-mode-storage';
import type { OrchestratorBackendSetting } from '../operator-defaults';
import { useUltraEffortPreference } from './UltraEffortPreference';
import {
  readComposerEffortMaps,
  resolveComposerLeadCatalogueLabel,
  resolveComposerSelectorState,
  resolveSupportedEffortChange,
  setModelEffort,
  supportedEffortsForLead,
  writeComposerModelEffort,
  type ComposerEffortClampNotice,
  type ComposerEffortMap,
  type ComposerSelectorMode,
} from './state';
import {
  FALLBACK_COMPOSER_WORKER_DEFAULTS,
  normalizeComposerWorkerDefaults,
  workerModelForDisplay,
  type ComposerWorkerDefaults,
} from './worker-settings';

type WorkerDefaultsPatch = Partial<Pick<
  ComposerWorkerDefaults,
  'defaultDispatchRuntime' | 'opencodeWorkerModel' | 'workerStartMode'
>>;

const EMPTY_COMPOSER_EFFORTS: ComposerEffortMap = {};

function sessionEffortKey(threadId: string | null): string {
  return threadId ?? '__fresh__';
}

export function useComposerSelectorState(input: {
  enabled: boolean;
  mode: ComposerSelectorMode | undefined;
  modeStorageId?: string;
  modelId: string | undefined;
  modelLabel: string;
  backend: OrchestratorBackendSetting | undefined;
  effort: ThinkingEffort;
  operatorDefaultEffort: ThinkingEffort;
  adaptiveEnabled: boolean;
  threadId: string | null;
  repoPath?: string | null;
  isFreePlan?: boolean;
  onModeChange?: (mode: ComposerSelectorMode) => void;
  onModelRestore?: (model: string) => void;
  onModelChange?: (model: string) => void;
  onBackendChange?: (backend: OrchestratorBackendSetting, model?: string) => void;
  onEffortChange: (effort: ThinkingEffort) => void;
}) {
  const {
    enabled,
    mode,
    modeStorageId,
    modelId,
    modelLabel,
    backend,
    effort,
    operatorDefaultEffort,
    adaptiveEnabled,
    threadId,
    repoPath,
    isFreePlan: freePlanOverride,
    onModeChange: changeMode,
    onModelRestore: restoreModel,
    onModelChange: changeModel,
    onBackendChange: changeBackend,
    onEffortChange: changeEffort,
  } = input;
  const inSessionEffortsRef = useRef<Record<string, ComposerEffortMap>>({});
  const lastResolvedModelRef = useRef<string | null>(null);
  const modelIdRef = useRef(modelId);
  const restoreModelRef = useRef(restoreModel);
  const [clampNotice, setClampNotice] = useState<ComposerEffortClampNotice | null>(null);
  const [storedEffortSnapshot, setStoredEffortSnapshot] = useState<{
    key: string;
    efforts: ComposerEffortMap;
  }>(() => {
    const maps = modelId ? readComposerEffortMaps(threadId, modelId) : { global: {}, thread: {} };
    return {
      key: `${threadId ?? ''}:${modelId ?? ''}`,
      efforts: { ...maps.global, ...maps.thread },
    };
  });
  const [threadMode, setThreadMode] = useState<ComposerSelectorMode>(() => (
    modeStorageId ? readStoredComposerMode(modeStorageId) : mode ?? 'solo'
  ));
  const [inSessionMode, setInSessionMode] = useState<ComposerSelectorMode | undefined>();
  const [operatorWorkerDefaults, setOperatorWorkerDefaults] = useState<ComposerWorkerDefaults>(
    FALLBACK_COMPOSER_WORKER_DEFAULTS,
  );
  const [workerOverrides, setWorkerOverrides] = useState<WorkerDefaultsPatch>({});
  const [workerModelLocked, setWorkerModelLocked] = useState(false);
  const [savingWorkerDefaults, setSavingWorkerDefaults] = useState(false);
  const modeStorageIdRef = useRef(modeStorageId);
  const parentModeRef = useRef(mode);
  const requestedModeRef = useRef<ComposerSelectorMode | undefined>(undefined);
  const adoptingParentModeRef = useRef<ComposerSelectorMode | undefined>(undefined);
  const { plan } = useEntitlement();
  const isFreePlan = freePlanOverride ?? plan === 'free';
  const ultraEnabled = useUltraEffortPreference();
  const { groups: baseComposerModelGroups } = useComposerModelCatalogue();

  const localLead = useMemo(
    () => backend === 'codex' && modelId ? parseLocalModel(modelId) : null,
    [backend, modelId],
  );
  const composerModelGroups = useMemo(() => {
    if (!localLead || baseComposerModelGroups.some((group) => (
      group.options.some((option) => (option.model ?? option.value) === modelId)
    ))) {
      return baseComposerModelGroups;
    }
    return baseComposerModelGroups.map((group) => group.key === 'codex' ? {
      ...group,
      options: [{
        value: modelId ?? '',
        label: formatModelLabel(localLead.model),
        backend: 'codex' as const,
        model: modelId,
        sub: `${localLead.provider} · local`,
      }, ...group.options],
    } : group);
  }, [baseComposerModelGroups, localLead, modelId]);

  const workerDefaults = useMemo(
    () => ({ ...operatorWorkerDefaults, ...workerOverrides }),
    [operatorWorkerDefaults, workerOverrides],
  );
  const refetchWorkerDefaults = useCallback(async () => {
    try {
      const response = await fetchOperatorDefaultsValues();
      if (!response.ok) return;
      const payload = await response.json() as {
        values?: Partial<ComposerWorkerDefaults>;
        sources?: Partial<Record<keyof ComposerWorkerDefaults, string>>;
      };
      setOperatorWorkerDefaults(normalizeComposerWorkerDefaults(payload.values ?? {}));
      setWorkerModelLocked(payload.sources?.opencodeWorkerModel === 'env');
    } catch {
      // Keep the last confirmed operator defaults.
    }
  }, []);

  useEffect(() => {
    if (enabled) void refetchWorkerDefaults();
  }, [enabled, refetchWorkerDefaults]);

  useEffect(() => {
    if (modeStorageIdRef.current !== modeStorageId) {
      modeStorageIdRef.current = modeStorageId;
      setInSessionMode(undefined);
      setThreadMode(modeStorageId ? readStoredComposerMode(modeStorageId) : mode ?? 'solo');
    }
  }, [mode, modeStorageId]);

  useEffect(() => {
    if (!mode || parentModeRef.current === mode) return;
    parentModeRef.current = mode;
    if (requestedModeRef.current === mode) {
      requestedModeRef.current = undefined;
      return;
    }
    adoptingParentModeRef.current = mode;
    setInSessionMode(mode);
    if (modeStorageId) writeStoredComposerMode(modeStorageId, mode);
  }, [mode, modeStorageId]);

  useEffect(() => {
    modelIdRef.current = modelId;
  }, [modelId]);

  useEffect(() => {
    restoreModelRef.current = restoreModel;
  }, [restoreModel]);

  useEffect(() => {
    if (!enabled || !repoPath) return;
    const storedModel = readStoredOrchestratorModel(repoPath);
    if (storedModel && storedModel !== modelIdRef.current) restoreModelRef.current?.(storedModel);
  }, [enabled, repoPath, threadId]);

  const storedEffortKey = `${threadId ?? ''}:${modelId ?? ''}`;
  useEffect(() => {
    const maps = modelId ? readComposerEffortMaps(threadId, modelId) : { global: {}, thread: {} };
    setStoredEffortSnapshot({
      key: storedEffortKey,
      efforts: { ...maps.global, ...maps.thread },
    });
  }, [modelId, storedEffortKey, threadId]);
  const storedEfforts = storedEffortSnapshot.key === storedEffortKey
    ? storedEffortSnapshot.efforts
    : EMPTY_COMPOSER_EFFORTS;
  const effortKey = sessionEffortKey(threadId);
  const currentSessionEfforts = inSessionEffortsRef.current[effortKey] ?? EMPTY_COMPOSER_EFFORTS;
  const resolvedModelLabel = backend && modelId
    ? resolveComposerLeadCatalogueLabel(
      backend,
      modelId,
      modelLabel,
      composerModelGroups.flatMap((group) => group.options),
    )
    : modelLabel;
  const workerModel = workerModelForDisplay(workerDefaults.defaultDispatchRuntime, workerDefaults);
  const resolved = useMemo(() => resolveComposerSelectorState({
    mode: mode ?? 'solo',
    leadModelId: modelId ?? '',
    leadModelLabel: resolvedModelLabel,
    leadBackend: backend ?? 'codex',
    inSessionEffortByModel: currentSessionEfforts,
    threadEffortByModel: storedEfforts,
    operatorDefaultEffort,
    adaptiveEnabled,
    ultraEnabled,
    isFreePlan,
    inSessionSettings: {
      ...(inSessionMode ? { mode: inSessionMode } : {}),
      ...(workerOverrides.defaultDispatchRuntime
        ? { workerRuntime: workerOverrides.defaultDispatchRuntime }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(workerOverrides, 'opencodeWorkerModel')
        ? { workerModel: workerOverrides.opencodeWorkerModel }
        : {}),
      ...(workerOverrides.workerStartMode
        ? { workerStartMode: workerOverrides.workerStartMode }
        : {}),
    },
    threadSettings: { mode: threadMode },
    operatorDefaultSettings: {
      workerRuntime: operatorWorkerDefaults.defaultDispatchRuntime,
      workerModel,
      workerStartMode: operatorWorkerDefaults.workerStartMode,
    },
    clampNotice,
  }), [
    adaptiveEnabled,
    backend,
    clampNotice,
    currentSessionEfforts,
    modelId,
    mode,
    operatorDefaultEffort,
    operatorWorkerDefaults.defaultDispatchRuntime,
    operatorWorkerDefaults.workerStartMode,
    isFreePlan,
    resolvedModelLabel,
    storedEfforts,
    inSessionMode,
    threadMode,
    ultraEnabled,
    workerOverrides,
    workerModel,
  ]);

  useEffect(() => {
    if (adoptingParentModeRef.current === mode) {
      if (mode === resolved.mode) adoptingParentModeRef.current = undefined;
      return;
    }
    if (!enabled || !changeMode || mode === resolved.mode) return;
    requestedModeRef.current = resolved.mode;
    changeMode(resolved.mode);
  }, [changeMode, enabled, mode, resolved.mode]);

  useEffect(() => {
    if (!enabled || !modelId || !backend) return;
    const resolutionKey = `${threadId ?? ''}:${backend}:${modelId}:${adaptiveEnabled}:${ultraEnabled}:${isFreePlan}`;
    if (lastResolvedModelRef.current === resolutionKey) return;
    lastResolvedModelRef.current = resolutionKey;
    const effortKey = sessionEffortKey(threadId);
    inSessionEffortsRef.current[effortKey] = setModelEffort(
      inSessionEffortsRef.current[effortKey] ?? {},
      modelId,
      resolved.effort,
    );
    let cancelled = false;
    window.queueMicrotask(() => {
      if (cancelled) return;
      setClampNotice(resolved.effortClampedFrom ? { modelId, from: resolved.effortClampedFrom } : null);
    });
    if (resolved.effortClampedFrom) {
      writeComposerModelEffort(modelId, resolved.effort, threadId);
    }
    if (resolved.effort !== effort) changeEffort(resolved.effort);
    return () => { cancelled = true; };
  }, [adaptiveEnabled, backend, changeEffort, effort, enabled, isFreePlan, modelId, resolved.effort, resolved.effortClampedFrom, threadId, ultraEnabled]);

  const onModeChange = useCallback((nextMode: ComposerSelectorMode) => {
    requestedModeRef.current = nextMode;
    setInSessionMode(nextMode);
    if (modeStorageId) writeStoredComposerMode(modeStorageId, nextMode);
    changeMode?.(nextMode);
  }, [changeMode, modeStorageId]);

  const onEffortChange = useCallback((nextEffort: ThinkingEffort) => {
    setClampNotice(null);
    const supported = backend
      ? supportedEffortsForLead(backend, modelId ?? '', adaptiveEnabled, isFreePlan, ultraEnabled)
      : [nextEffort];
    const change = resolveSupportedEffortChange(nextEffort, effort, supported);
    if (!change.accepted) {
      if (change.effort !== effort) changeEffort(change.effort);
      return;
    }
    if (change.effort === effort) {
      if (modelId) writeComposerModelEffort(modelId, change.effort, threadId);
      return;
    }
    if (!modelId) return changeEffort(change.effort);
    const effortKey = sessionEffortKey(threadId);
    inSessionEffortsRef.current[effortKey] = setModelEffort(
      inSessionEffortsRef.current[effortKey] ?? {},
      modelId,
      change.effort,
    );
    writeComposerModelEffort(modelId, change.effort, threadId);
    changeEffort(change.effort);
  }, [adaptiveEnabled, backend, changeEffort, effort, isFreePlan, modelId, threadId, ultraEnabled]);

  const onModelChange = useCallback((nextModel: string) => {
    if (modelId) {
      const effortKey = sessionEffortKey(threadId);
      inSessionEffortsRef.current[effortKey] = setModelEffort(
        inSessionEffortsRef.current[effortKey] ?? {},
        modelId,
        effort,
      );
      writeComposerModelEffort(modelId, effort, threadId);
    }
    writeStoredOrchestratorModel(repoPath, nextModel);
    changeModel?.(nextModel);
  }, [changeModel, effort, modelId, repoPath, threadId]);

  const onBackendChange = useCallback((nextBackend: OrchestratorBackendSetting, nextModel?: string) => {
    if (modelId) {
      const effortKey = sessionEffortKey(threadId);
      inSessionEffortsRef.current[effortKey] = setModelEffort(
        inSessionEffortsRef.current[effortKey] ?? {},
        modelId,
        effort,
      );
      writeComposerModelEffort(modelId, effort, threadId);
    }
    changeBackend?.(nextBackend, nextModel);
  }, [changeBackend, effort, modelId, threadId]);

  const persistWorkerDefaults = useCallback(async (patch: WorkerDefaultsPatch) => {
    setWorkerOverrides((current) => ({ ...current, ...patch }));
    setSavingWorkerDefaults(true);
    try {
      await updateOperatorDefaultsValues(patch);
    } catch {
      // The confirmed read below restores server truth after a failed write.
    } finally {
      await refetchWorkerDefaults();
      setWorkerOverrides({});
      setSavingWorkerDefaults(false);
    }
  }, [refetchWorkerDefaults]);

  const onRuntimeChange = useCallback((defaultDispatchRuntime: OrchestratorRuntime) => {
    void persistWorkerDefaults({ defaultDispatchRuntime });
  }, [persistWorkerDefaults]);
  const onWorkerModelChange = useCallback((opencodeWorkerModel: string | null) => {
    if (!workerModelLocked) void persistWorkerDefaults({ opencodeWorkerModel });
  }, [persistWorkerDefaults, workerModelLocked]);
  const onWorkerStartModeChange = useCallback((workerStartMode: WorkerStartMode) => {
    void persistWorkerDefaults({ workerStartMode });
  }, [persistWorkerDefaults]);

  return {
    state: resolved,
    defaults: workerDefaults,
    composerModelGroups,
    onModeChange,
    onEffortChange,
    onModelChange,
    onBackendChange,
    onRuntimeChange,
    onWorkerModelChange,
    onWorkerStartModeChange,
    refreshWorkerDefaults: refetchWorkerDefaults,
    clampNotice,
    isFreePlan,
    savingWorkerDefaults,
    workerModelLocked,
  };
}

export type ComposerSelectorController = ReturnType<typeof useComposerSelectorState>;
