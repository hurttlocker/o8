/**
 * PR link destination operator flag (Git & PRs settings).
 *
 * 'in-app' (the default) opens a PR row in the embedded PrPanel; 'browser'
 * hands the github.com/.../pull URL to the OS browser. Mirrors
 * useNativeBrowserViewFlag: defaults to the current behavior while the fetch
 * resolves, caches the resolved value for later mounts, and only flips off the
 * default when the operator setting says so.
 */
'use client';

import { useEffect, useState } from 'react';
import type { PrLinkDestination } from '@/lib/operator/defaults-env';

let cached: PrLinkDestination | null = null;

export function usePrLinkDestinationFlag(): PrLinkDestination {
  const [value, setValue] = useState<PrLinkDestination>(cached ?? 'in-app');
  useEffect(() => {
    if (cached !== null) return;
    let cancelled = false;
    fetch('/api/panel/operator-defaults')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data || typeof data !== 'object') return;
        const next = (data as { values?: { prLinkDestination?: unknown } }).values?.prLinkDestination;
        if (next === 'in-app' || next === 'browser') {
          cached = next;
          setValue(next);
        }
      })
      .catch(() => {
        // Transient failure → stay on the default; next mount re-fetches.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return value;
}
