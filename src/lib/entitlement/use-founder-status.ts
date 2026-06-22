/**
 * Founder-status hook — true when the signed-in account is a Founding Operator.
 *
 * Founders get the early-access perk ("experimental is always on for you,
 * forever" — docs/founding-operator-tier.md), so the experimental* operator
 * flags OR-in this signal. Kept as a standalone module-cached fetch (mirroring
 * the use-experimental-*.ts hooks) rather than reading EntitlementContext, so it
 * works on every surface — including the canvas tree, which isn't wrapped by
 * EntitlementProvider. Returns false for everyone who isn't a founder, so
 * non-founder behavior is unchanged.
 */
'use client';

import { useEffect, useState } from 'react';

let cached: boolean | null = null;

// Returns null on ANY failure so a transient hiccup is never cached as `false`
// (which would pin a founder's early access OFF until reload — same guard the
// experimental flag hooks use).
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
  const [isFounder, setIsFounder] = useState<boolean>(cached ?? false);
  useEffect(() => {
    if (cached !== null) { setIsFounder(cached); return; }
    let cancelled = false;
    const controller = new AbortController();
    void fetchFounder(controller.signal).then((value) => {
      if (cancelled || value === null) return;
      cached = value;
      setIsFounder(value);
    });
    return () => { cancelled = true; controller.abort(); };
  }, []);
  return isFounder;
}
