/**
 * Native browser-view operator flag (Stage 6).
 *
 * When ON (the default), the embedded Browser pane renders in a host-owned child
 * WebviewWindow — origin-sensitive auth apps (Clerk) render natively AND stay
 * agent-grabbable. When OFF, the iframe/proxy + engine fallback renders instead.
 *
 * Unlike the experimental flags (which default OFF and fetch via
 * useRetryingRemoteFlag), this defaults TRUE *while loading* so the native
 * surface mounts immediately — otherwise O8BrowserPane would flash the iframe on
 * first open before the fetch resolves. A module cache keeps later mounts sync; a
 * real `false` from the operator setting flips it off.
 */
'use client';

import { useEffect, useState } from 'react';
import { fetchOperatorDefaultsValues } from '@/lib/operator/operator-defaults-values-client';

let cached: boolean | null = null;

export function useNativeBrowserViewFlag(): boolean {
  const [flag, setFlag] = useState<boolean>(cached ?? true);
  useEffect(() => {
    // The useState initializer already used a resolved cache; only fetch when
    // it's still unknown (first mount this session).
    if (cached !== null) return;
    let cancelled = false;
    fetchOperatorDefaultsValues()
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data || typeof data !== 'object') return;
        const value = (data as { values?: { nativeBrowserView?: unknown } }).values?.nativeBrowserView;
        if (typeof value === 'boolean') {
          cached = value;
          setFlag(value);
        }
      })
      .catch(() => {
        // Transient failure → stay on the default (ON); next mount re-fetches.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return flag;
}
