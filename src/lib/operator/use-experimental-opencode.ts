/**
 * Experimental opencode operator flag.
 *
 * When off, opencode stays hidden from the dispatch picker and CLI runtime pickers.
 * Off by default for v1, mirroring the sibling flag in `use-experimental-gemini.ts`.
 * Founding Operators get it ON regardless (early-access perk) — see useFounderStatus.
 */
'use client';

import { useEffect, useState } from 'react';

import { useFounderStatus } from '@/lib/entitlement/use-founder-status';

let cached: boolean | null = null;

// Returns null on any failure so a transient hiccup is never cached as `false`
// (which would pin the flag off until a full reload — see use-experimental-canvas).
async function fetchFlag(signal?: AbortSignal): Promise<boolean | null> {
  try {
    const response = await fetch('/api/panel/operator-defaults', { signal });
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
  const [flag, setFlag] = useState<boolean>(cached ?? false);
  useEffect(() => {
    if (cached !== null) { setFlag(cached); return; }
    let cancelled = false;
    const controller = new AbortController();
    void fetchFlag(controller.signal).then((value) => {
      if (cancelled || value === null) return;
      cached = value;
      setFlag(value);
    });
    return () => { cancelled = true; controller.abort(); };
  }, []);
  // Founders get early access regardless of the operator default.
  return flag || isFounder;
}
