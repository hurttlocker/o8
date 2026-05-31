/**
 * Experimental opencode operator flag.
 *
 * When off, opencode stays hidden from the dispatch picker and CLI runtime pickers.
 * Off by default for v1, mirroring the sibling flag in `use-experimental-gemini.ts`.
 */
'use client';

import { useEffect, useState } from 'react';

let cached: boolean | null = null;

async function fetchFlag(signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch('/api/panel/operator-defaults', { signal });
    if (!response.ok) return false;
    const data = await response.json().catch(() => null);
    return Boolean(data?.values?.experimentalOpencode);
  } catch {
    return false;
  }
}

export function useExperimentalOpencodeFlag(): boolean {
  const [flag, setFlag] = useState<boolean>(cached ?? false);
  useEffect(() => {
    if (cached !== null) { setFlag(cached); return; }
    let cancelled = false;
    const controller = new AbortController();
    void fetchFlag(controller.signal).then((value) => {
      if (cancelled) return;
      cached = value;
      setFlag(value);
    });
    return () => { cancelled = true; controller.abort(); };
  }, []);
  return flag;
}
