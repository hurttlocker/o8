'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  readComposerEffortMaps,
  resolveComposerSelectorState,
  resolveSupportedEffortChange,
  setModelEffort,
  supportedEffortsForLead,
  writeComposerModelEffort,
  type ComposerEffortMap,
  type ComposerEffortClampNotice,
  type ComposerSelectorMode,
} from './state';
import type { OrchestratorBackendSetting } from '../operator-defaults';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { useEntitlement } from '@/lib/entitlement/context';

export function useComposerSelectorState(input: {
  enabled: boolean;
  mode: ComposerSelectorMode | undefined;
  modelId: string | undefined;
  modelLabel: string;
  backend: OrchestratorBackendSetting | undefined;
  effort: ThinkingEffort;
  operatorDefaultEffort: ThinkingEffort;
  adaptiveEnabled: boolean;
  threadId: string | null;
  onModelChange?: (model: string) => void;
  onBackendChange?: (backend: OrchestratorBackendSetting, model?: string) => void;
  onEffortChange: (effort: ThinkingEffort) => void;
}) {
  const {
    enabled,
    mode,
    modelId,
    modelLabel,
    backend,
    effort,
    operatorDefaultEffort,
    adaptiveEnabled,
    threadId,
    onModelChange: changeModel,
    onBackendChange: changeBackend,
    onEffortChange: changeEffort,
  } = input;
  const inSessionEffortsRef = useRef<ComposerEffortMap>({});
  const lastResolvedModelRef = useRef<string | null>(null);
  const [clampNotice, setClampNotice] = useState<ComposerEffortClampNotice | null>(null);
  const { plan } = useEntitlement();

  const resolveModelEffort = useCallback((nextModelId: string, nextBackend: OrchestratorBackendSetting) => {
    const persisted = readComposerEffortMaps(threadId, nextModelId);
    return resolveComposerSelectorState({
      mode: mode ?? 'solo',
      leadModelId: nextModelId,
      leadModelLabel: modelLabel,
      leadBackend: nextBackend,
      inSessionEffortByModel: inSessionEffortsRef.current,
      threadEffortByModel: { ...persisted.global, ...persisted.thread },
      operatorDefaultEffort,
      adaptiveEnabled,
      isFreePlan: plan === 'free',
      workerRuntimeLabel: '',
    });
  }, [adaptiveEnabled, mode, modelLabel, operatorDefaultEffort, plan, threadId]);

  useEffect(() => {
    if (!enabled || !modelId || !backend) return;
    const resolutionKey = `${threadId ?? ''}:${backend}:${modelId}`;
    if (lastResolvedModelRef.current === resolutionKey) return;
    lastResolvedModelRef.current = resolutionKey;
    const resolved = resolveModelEffort(modelId, backend);
    inSessionEffortsRef.current = setModelEffort(inSessionEffortsRef.current, modelId, resolved.effort);
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
  }, [
    backend,
    changeEffort,
    effort,
    enabled,
    modelId,
    resolveModelEffort,
    threadId,
  ]);

  const onEffortChange = useCallback((nextEffort: ThinkingEffort) => {
    setClampNotice(null);
    const supported = backend
      ? supportedEffortsForLead(backend, modelId ?? '', adaptiveEnabled, plan === 'free')
      : [nextEffort];
    const change = resolveSupportedEffortChange(nextEffort, effort, supported);
    if (!change.accepted) {
      if (change.effort !== effort) changeEffort(change.effort);
      return;
    }
    if (change.effort === effort) return;
    if (!modelId) return changeEffort(change.effort);
    inSessionEffortsRef.current = setModelEffort(inSessionEffortsRef.current, modelId, change.effort);
    writeComposerModelEffort(modelId, change.effort, threadId);
    changeEffort(change.effort);
  }, [adaptiveEnabled, backend, changeEffort, effort, modelId, plan, threadId]);

  const onModelChange = useCallback((model: string) => {
    if (modelId) {
      inSessionEffortsRef.current = setModelEffort(inSessionEffortsRef.current, modelId, effort);
      writeComposerModelEffort(modelId, effort, threadId);
    }
    changeModel?.(model);
  }, [changeModel, effort, modelId, threadId]);

  const onBackendChange = useCallback((nextBackend: OrchestratorBackendSetting, model?: string) => {
    if (modelId) {
      inSessionEffortsRef.current = setModelEffort(inSessionEffortsRef.current, modelId, effort);
      writeComposerModelEffort(modelId, effort, threadId);
    }
    changeBackend?.(nextBackend, model);
  }, [changeBackend, effort, modelId, threadId]);

  return {
    onEffortChange,
    onModelChange,
    onBackendChange,
    clampNotice,
    isFreePlan: plan === 'free',
  };
}
