'use client';

import { isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { DEFAULT_ORCHESTRATOR_MODEL } from './use-orchestrator-stream/shared';

interface OperatorDefaultsPayload {
  values?: {
    orchestratorModel?: unknown;
    thinkingEffort?: unknown;
  };
}

export interface ThoughtsOperatorDefaults {
  orchestratorModel: string;
  thinkingEffort: ThinkingEffort;
}

export const THOUGHTS_OPERATOR_DEFAULTS_FALLBACK: ThoughtsOperatorDefaults = {
  orchestratorModel: DEFAULT_ORCHESTRATOR_MODEL,
  thinkingEffort: 'adaptive',
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

  return {
    orchestratorModel,
    thinkingEffort,
  };
}
