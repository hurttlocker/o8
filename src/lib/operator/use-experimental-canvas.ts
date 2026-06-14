'use client';

import { useEffect, useState } from 'react';

let cached: boolean | null = null;

// Returns null on ANY failure (non-OK response, parse error, abort/network) so a
// transient hiccup is NEVER cached. Previously this returned `false` on error,
// which the caller cached permanently — one failed read (a slow boot, a brief API
// blip, or unmounting mid-fetch → abort) pinned Canvas mode OFF until a full app
// reload. Only successful reads get cached now.
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
  const [flag, setFlag] = useState<boolean>(cached ?? false);
  useEffect(() => {
    if (cached !== null) { setFlag(cached); return; }
    let cancelled = false;
    const controller = new AbortController();
    void fetchFlag(controller.signal).then((value) => {
      // Only cache + apply a real (non-null) read; transient failures retry next mount.
      if (cancelled || value === null) return;
      cached = value;
      setFlag(value);
    });
    return () => { cancelled = true; controller.abort(); };
  }, []);
  return flag;
}
