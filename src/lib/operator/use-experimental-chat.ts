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
  // RETIRED (Q ruling 2026-07-14): the separate casual "Chat" surface is
  // gone — the o8 model merged into the Orchestrator chat, which is now the
  // one conversation surface for every tier. This hook pins FALSE so the
  // default llm-chat tab never spawns, existing llm-chat tabs stay hidden
  // (visibleTabs filter), and the launch pickers drop the Chat option.
  // The remote-flag plumbing stays readable as a re-entry seam, but it can
  // no longer turn the surface back on.
  void useRetryingRemoteFlag(fetchFlag, cache);
  void isFounder;
  return false;
}
