/**
 * Founder-status hook — true when the signed-in account is a Founding Operator.
 *
 * Founders get the early-access perk, so the experimental* operator
 * flags OR-in this signal. Kept as a standalone module-cached fetch (mirroring
 * the use-experimental-*.ts hooks) rather than reading EntitlementContext, so it
 * works on every surface — including the canvas tree, which isn't wrapped by
 * EntitlementProvider. Returns false for everyone who isn't a founder, so
 * non-founder behavior is unchanged.
 *
 * Shares the retrying remote-flag reader so a transient failure on full-page
 * canvas entry never pins a founder's access OFF until reload (see
 * use-remote-flag — that combined with the canvas flag failing is how the
 * canvas went black-with-no-header).
 */
'use client';

import { useRetryingRemoteFlag, type FlagCache } from '@/lib/operator/use-remote-flag';

const cache: FlagCache = { value: null };

// Returns null on ANY failure so a transient hiccup is never cached as `false`
// (which would pin a founder's early access OFF). The retry layer in
// useRetryingRemoteFlag re-fetches a null instead of giving up.
async function fetchFounder(signal?: AbortSignal): Promise<boolean | null> {
  try {
    const response = await fetch('/api/panel/entitlement', { signal });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') return null;
    return (data as { plan?: unknown }).plan === 'founder';
  } catch {
    return null;
  }
}

export function useFounderStatus(): boolean {
  return useRetryingRemoteFlag(fetchFounder, cache);
}
