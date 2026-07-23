'use client';

import { useFounderStatus } from '@/lib/entitlement/use-founder-status';
import { useRetryingRemoteFlag, type FlagCache } from '@/lib/operator/use-remote-flag';

const cache: FlagCache = { value: null };

// Returns null on ANY failure (non-OK response, parse error, abort/network) so a
// transient hiccup is NEVER cached. The retry layer in useRetryingRemoteFlag
// re-fetches a null instead of giving up — previously a single failed read on
// full-page canvas entry pinned Canvas mode OFF (the black #0a0c10 "Canvas mode
// is off" screen, no header) until a manual reload.
async function fetchFlag(signal?: AbortSignal): Promise<boolean | null> {
  try {
    const response = await fetch('/api/panel/operator-defaults', { signal });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') return null;
    return Boolean((data as { values?: { experimentalCanvas?: unknown } }).values?.experimentalCanvas);
  } catch {
    return null;
  }
}

export function useExperimentalCanvasFlag(): boolean {
  const isFounder = useFounderStatus();
  // Canvas is OUT OF BETA (Q ruling 2026-07-14): the button and mechanics are
  // on for everyone, including every look and cosmetic control. The hook shape
  // survives so call sites don't churn; the remote flag + founder read stay
  // wired for a future kill-switch but can no longer turn Canvas off.
  void useRetryingRemoteFlag(fetchFlag, cache);
  void isFounder;
  return true;
}
