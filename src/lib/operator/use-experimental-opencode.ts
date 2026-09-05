/**
 * Experimental opencode operator flag.
 *
 * When off, opencode stays hidden from the dispatch picker and CLI runtime pickers.
 * Off by default for v1, mirroring the sibling flag in `use-experimental-gemini.ts`.
 * Founding Operators get it ON regardless (early-access perk) — see useFounderStatus.
 */
'use client';

import { useFounderStatus } from '@/lib/entitlement/use-founder-status';
import { fetchOperatorDefaultsValues } from '@/lib/operator/operator-defaults-values-client';
import { useRetryingRemoteFlag, type FlagCache } from '@/lib/operator/use-remote-flag';

const cache: FlagCache = { value: null };

// Returns null on any failure so a transient hiccup is never cached as `false`.
// The retry layer in useRetryingRemoteFlag re-fetches a null instead of pinning
// the flag off until a full reload (see use-experimental-canvas).
async function fetchFlag(signal?: AbortSignal): Promise<boolean | null> {
  try {
    const response = await fetchOperatorDefaultsValues();
    if (signal?.aborted) return null;
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') return null;
    return Boolean((data as { values?: { experimentalOpencode?: unknown } }).values?.experimentalOpencode);
  } catch {
    return null;
  }
}

export function useExperimentalOpencodeFlag(): boolean {
  const isFounder = useFounderStatus();
  // Founders get early access regardless of the operator default.
  return useRetryingRemoteFlag(fetchFlag, cache) || isFounder;
}
