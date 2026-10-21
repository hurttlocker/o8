/**
 * Early-access hook for the shared paid-plan entitlement.
 *
 * The experimental* operator flags OR-in this signal. Kept as a standalone
 * module-cached fetch (mirroring the use-experimental-*.ts hooks) rather than
 * reading EntitlementContext, so it
 * works on every surface — including the canvas tree, which isn't wrapped by
 * EntitlementProvider. Lifetime identity remains separate from this capability.
 *
 * Shares the retrying remote-flag reader so a transient failure on full-page
 * canvas entry never pins early access OFF until reload (see
 * use-remote-flag — that combined with the canvas flag failing is how the
 * canvas went black-with-no-header).
 */
'use client';

import { useRetryingRemoteFlag, type FlagCache } from '@/lib/operator/use-remote-flag';
import { isPaidPlan } from '@/lib/entitlement/flags';
import type { Plan } from '@/lib/entitlement/types';

const cache: FlagCache = { value: null };

// Returns null on ANY failure so a transient hiccup is never cached as `false`
// (which would pin early access OFF). The retry layer in
// useRetryingRemoteFlag re-fetches a null instead of giving up.
async function fetchEarlyAccess(signal?: AbortSignal): Promise<boolean | null> {
  try {
    const response = await fetch('/api/panel/entitlement', { signal });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') return null;
    return isPaidPlan((data as { plan: Plan }).plan);
  } catch {
    return null;
  }
}

export function useEarlyAccess(): boolean {
  return useRetryingRemoteFlag(fetchEarlyAccess, cache);
}
