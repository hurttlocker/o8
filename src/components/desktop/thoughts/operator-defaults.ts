'use client';

import { isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { DEFAULT_ORCHESTRATOR_MODEL } from './use-orchestrator-stream/shared';

interface OperatorDefaultsPayload {
  values?: {
    orchestratorModel?: unknown;
    thinkingEffort?: unknown;
    experimentalOpencode?: unknown;
    experimentalGemini?: unknown;
  };
}

export interface ThoughtsOperatorDefaults {
  orchestratorModel: string;
  thinkingEffort: ThinkingEffort;
  experimentalOpencode: boolean;
  experimentalGemini: boolean;
}

export const THOUGHTS_OPERATOR_DEFAULTS_FALLBACK: ThoughtsOperatorDefaults = {
  orchestratorModel: DEFAULT_ORCHESTRATOR_MODEL,
  thinkingEffort: 'adaptive',
  experimentalOpencode: false,
  experimentalGemini: false,
};

export async function fetchThoughtsOperatorDefaults(signal?: AbortSignal): Promise<ThoughtsOperatorDefaults> {
  try {
    const response = await fetch('/api/panel/operator-defaults', {
      cache: 'no-store',
      signal,
    });
    const payload = await response.json().catch(() => null) as OperatorDefaultsPayload | null;
    if (!response.ok) {
      throw new Error('Failed to load operator defaults.');
    }
    return normalizeThoughtsOperatorDefaults(payload);
  } catch {
    return THOUGHTS_OPERATOR_DEFAULTS_FALLBACK;
  }
}

function normalizeThoughtsOperatorDefaults(payload: OperatorDefaultsPayload | null): ThoughtsOperatorDefaults {
  const orchestratorModel = typeof payload?.values?.orchestratorModel === 'string' && payload.values.orchestratorModel.trim()
    ? payload.values.orchestratorModel.trim()
    : THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.orchestratorModel;
  const thinkingEffort = isThinkingEffort(payload?.values?.thinkingEffort)
    ? payload.values.thinkingEffort
    : THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.thinkingEffort;
  const experimentalOpencode = typeof payload?.values?.experimentalOpencode === 'boolean'
    ? payload.values.experimentalOpencode
    : THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.experimentalOpencode;
  const experimentalGemini = typeof payload?.values?.experimentalGemini === 'boolean'
    ? payload.values.experimentalGemini
    : THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.experimentalGemini;

  return {
    orchestratorModel,
    thinkingEffort,
    experimentalOpencode,
    experimentalGemini,
  };
}
