'use client';

import { useFounderStatus } from '@/lib/entitlement/use-founder-status';
import { useRetryingRemoteFlag, type FlagCache } from '@/lib/operator/use-remote-flag';

const cache: FlagCache = { value: null };

// Returns null on any failure so a transient hiccup is never cached as `false`.
// The retry layer in useRetryingRemoteFlag re-fetches a null instead of pinning
// the flag off until a full reload (see use-experimental-canvas).
async function fetchFlag(signal?: AbortSignal): Promise<boolean | null> {
  try {
    const response = await fetch('/api/panel/operator-defaults', { signal });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') return null;
    return Boolean((data as { values?: { experimentalChat?: unknown } }).values?.experimentalChat);
  } catch {
    return null;
  }
}

export function useExperimentalChatFlag(): boolean {
  const isFounder = useFounderStatus();
  // Founders get early access regardless of the operator default.
  return useRetryingRemoteFlag(fetchFlag, cache) || isFounder;
}
