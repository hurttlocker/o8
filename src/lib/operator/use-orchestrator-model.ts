/**
 * Resolved orchestrator model (operator default).
 *
 * Read-only hook for display surfaces that need to say which brain fleet
 * orchestration runs on (e.g. the ModePicker tag). Mirrors the fetch/cache
 * pattern in `use-experimental-opencode.ts`; falls back to Opus 4.8 — the
 * hardcoded default in `lib/operator/defaults.ts` — until the fetch lands.
 */
'use client';

import { useEffect, useState } from 'react';
import { MODEL_IDS } from '@/lib/models';
import { fetchOperatorDefaultsValues } from '@/lib/operator/operator-defaults-values-client';

const FALLBACK_MODEL = MODEL_IDS.orchestratorDefault;

let cached: string | null = null;

async function fetchModel(signal?: AbortSignal): Promise<string> {
  try {
    const response = await fetchOperatorDefaultsValues();
    if (signal?.aborted) return FALLBACK_MODEL;
    if (!response.ok) return FALLBACK_MODEL;
    const data = await response.json().catch(() => null);
    const model = typeof data?.values?.orchestratorModel === 'string' ? data.values.orchestratorModel.trim() : '';
    return model || FALLBACK_MODEL;
  } catch {
    return FALLBACK_MODEL;
  }
}

export function useOrchestratorModel(): string {
  const [model, setModel] = useState<string>(cached ?? FALLBACK_MODEL);
  useEffect(() => {
    if (cached !== null) return;
    let cancelled = false;
    const controller = new AbortController();
    void fetchModel(controller.signal).then((value) => {
      if (cancelled) return;
      cached = value;
      setModel(value);
    });
    return () => { cancelled = true; controller.abort(); };
  }, []);
  return cached ?? model;
}
