'use client';

import { isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { fetchOperatorDefaultsValues } from '@/lib/operator/operator-defaults-values-client';
import { DEFAULT_ORCHESTRATOR_MODEL } from './use-orchestrator-stream/shared';

interface OperatorDefaultsPayload {
  values?: {
    orchestratorModel?: unknown;
    orchestratorBackend?: unknown;
    inAppOrchestratorEnabled?: unknown;
    thinkingEffort?: unknown;
    experimentalOpencode?: unknown;
    experimentalGemini?: unknown;
  };
  dispatchableRuntimes?: Array<{
    available?: unknown;
  }>;
}

export const THOUGHTS_RUNTIME_READINESS_DELAY_MS = 5_000;

let readyRuntimeCount: number | null = null;
let readyRuntimeCountInFlight: Promise<number | null> | null = null;

import {
  isOrchestratorBackendSetting,
  type OrchestratorBackendSetting,
} from '@/lib/operator/backend-setting';

export type { OrchestratorBackendSetting };

// Named distinctly for its existing call-sites; the predicate itself is shared.
export const isThoughtsOrchestratorBackendSetting = isOrchestratorBackendSetting;

export interface ThoughtsOperatorDefaults {
  orchestratorModel: string;
  orchestratorBackend: OrchestratorBackendSetting;
  inAppOrchestratorEnabled: boolean;
  thinkingEffort: ThinkingEffort;
  experimentalOpencode: boolean;
  experimentalGemini: boolean;
  readyRuntimeCount: number | null;
}

export const THOUGHTS_OPERATOR_DEFAULTS_FALLBACK: ThoughtsOperatorDefaults = {
  orchestratorModel: DEFAULT_ORCHESTRATOR_MODEL,
  orchestratorBackend: 'auto',
  inAppOrchestratorEnabled: true,
  thinkingEffort: 'adaptive',
  experimentalOpencode: false,
  experimentalGemini: false,
  readyRuntimeCount: null,
};

export async function fetchThoughtsOperatorDefaults(signal?: AbortSignal): Promise<ThoughtsOperatorDefaults> {
  try {
    const response = await fetchOperatorDefaultsValues();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const payload = await response.json().catch(() => null) as OperatorDefaultsPayload | null;
    if (!response.ok) {
      throw new Error('Failed to load operator defaults.');
    }
    return normalizeThoughtsOperatorDefaults(payload);
  } catch {
    return THOUGHTS_OPERATOR_DEFAULTS_FALLBACK;
  }
}

export async function fetchThoughtsRuntimeReadiness(): Promise<number | null> {
  if (readyRuntimeCount !== null) return readyRuntimeCount;
  if (!readyRuntimeCountInFlight) {
    const request = fetch('/api/panel/operator-defaults', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return null;
        const payload = await response.json().catch(() => null) as OperatorDefaultsPayload | null;
        const normalized = normalizeThoughtsOperatorDefaults(payload).readyRuntimeCount;
        if (normalized !== null) readyRuntimeCount = normalized;
        return normalized;
      })
      .catch(() => null);
    readyRuntimeCountInFlight = request;
    request.then(
      () => { if (readyRuntimeCountInFlight === request) readyRuntimeCountInFlight = null; },
      () => { if (readyRuntimeCountInFlight === request) readyRuntimeCountInFlight = null; },
    );
  }
  return readyRuntimeCountInFlight;
}

export function scheduleThoughtsRuntimeReadiness(
  signal: AbortSignal,
  onReady: (readyRuntimeCount: number) => void,
): () => void {
  const timer = setTimeout(() => {
    void fetchThoughtsRuntimeReadiness().then((count) => {
      if (!signal.aborted && count !== null) onReady(count);
    });
  }, THOUGHTS_RUNTIME_READINESS_DELAY_MS);
  return () => clearTimeout(timer);
}

export function normalizeThoughtsOperatorDefaults(payload: OperatorDefaultsPayload | null): ThoughtsOperatorDefaults {
  const orchestratorModel = typeof payload?.values?.orchestratorModel === 'string' && payload.values.orchestratorModel.trim()
    ? payload.values.orchestratorModel.trim()
    : THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.orchestratorModel;
  const orchestratorBackend = isThoughtsOrchestratorBackendSetting(payload?.values?.orchestratorBackend)
    ? payload.values.orchestratorBackend
    : THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.orchestratorBackend;
  const inAppOrchestratorEnabled = typeof payload?.values?.inAppOrchestratorEnabled === 'boolean'
    ? payload.values.inAppOrchestratorEnabled
    : THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.inAppOrchestratorEnabled;
  const thinkingEffort = isThinkingEffort(payload?.values?.thinkingEffort)
    ? payload.values.thinkingEffort
    : THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.thinkingEffort;
  const experimentalOpencode = typeof payload?.values?.experimentalOpencode === 'boolean'
    ? payload.values.experimentalOpencode
    : THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.experimentalOpencode;
  const experimentalGemini = typeof payload?.values?.experimentalGemini === 'boolean'
    ? payload.values.experimentalGemini
    : THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.experimentalGemini;
  const readyRuntimeCount = Array.isArray(payload?.dispatchableRuntimes)
    ? payload.dispatchableRuntimes.filter((runtime) => runtime.available === true).length
    : THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.readyRuntimeCount;

  return {
    orchestratorModel,
    orchestratorBackend,
    inAppOrchestratorEnabled,
    thinkingEffort,
    experimentalOpencode,
    experimentalGemini,
    readyRuntimeCount,
  };
}
