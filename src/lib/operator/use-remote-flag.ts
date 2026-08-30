'use client';

import { useEffect, useState } from 'react';

/** A module-level cache cell shared across every consumer of one flag. */
export interface FlagCache {
  value: boolean | null;
}

/**
 * Read a remote boolean flag once, cache it process-wide, and RETRY transient
 * failures with backoff.
 *
 * The operator/entitlement flag hooks (canvas, founder, opencode, gemini, chat)
 * each read a boolean off a loopback API once and OR it into a capability gate.
 * The original implementation gave up after a single failed read (`null`) and
 * never re-fetched, because the effect runs once and "next mount" never comes
 * without a reload. On a full-page surface like the canvas that pinned the
 * feature OFF until a manual reload — and it's how the canvas went
 * black-with-no-header: the canvas + founder fetches BOTH raced a not-yet-ready
 * server on full-page entry, both returned null, and the page fell to the
 * disabled (#0a0c10) "Canvas mode is off" screen and stuck there. Q hit this at
 * laptop size; a right-click reload "fixed" it (a fresh mount that re-fetched).
 *
 * Retrying transient failures removes the stuck state — a successful read is
 * still cached process-wide and never re-fetched. A genuine `false` from the
 * server is a successful read, so a legitimately-off flag is honored on the
 * first try and never retried.
 *
 * REACTIVE TO SIGN-IN (#1277): the read is also re-run on the
 * `o8:entitlement-refresh` window event (dispatched by O8AuthProvider after a
 * Clerk sign-in / entitlement sync). Without this, the module cache held the
 * signed-out value and founder perks + experimental flags only flipped after a
 * manual reload. On the event we bust the SHARED cache and re-fetch, so every
 * consumer reflects the new plan live.
 */
export function useRetryingRemoteFlag(
  fetchFlag: (signal?: AbortSignal) => Promise<boolean | null>,
  cache: FlagCache,
): boolean {
  const [flag, setFlag] = useState<boolean>(cache.value ?? false);
  useEffect(() => {
    let cancelled = false;
    let controller = new AbortController();
    // Back off across a boot race / brief API blip before giving up (~11.7s of
    // attempts). One cheap GET per attempt; only fires while the read keeps
    // failing — a success or a real `false` ends it immediately.
    const delays = [400, 800, 1500, 3000, 6000];

    const run = () => {
      let attempt = 0;
      const attemptFetch = () => {
        void fetchFlag(controller.signal).then((value) => {
          if (cancelled) return;
          if (value === null) {
            if (attempt < delays.length) {
              const wait = delays[attempt];
              attempt += 1;
              window.setTimeout(() => {
                if (!cancelled) attemptFetch();
              }, wait);
            }
            return;
          }
          cache.value = value;
          setFlag(value);
        });
      };
      attemptFetch();
    };

    // Honor a cached value on mount; otherwise fetch (with retry).
    if (cache.value === null) {
      run();
    }

    // Sign-in / entitlement change → bust the SHARED cache + re-fetch so the new
    // plan flips without a reload. Every mounted consumer re-reads; the first
    // success repopulates the cache for later mounts.
    const onRefresh = () => {
      cache.value = null;
      controller.abort();
      controller = new AbortController();
      run();
    };
    window.addEventListener('o8:entitlement-refresh', onRefresh);

    return () => {
      cancelled = true;
      controller.abort();
      window.removeEventListener('o8:entitlement-refresh', onRefresh);
    };
  }, [fetchFlag, cache]);
  return cache.value ?? flag;
}
