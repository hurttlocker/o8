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
 */
export function useRetryingRemoteFlag(
  fetchFlag: (signal?: AbortSignal) => Promise<boolean | null>,
  cache: FlagCache,
): boolean {
  const [flag, setFlag] = useState<boolean>(cache.value ?? false);
  useEffect(() => {
    if (cache.value !== null) {
      setFlag(cache.value);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    // Back off across a boot race / brief API blip before giving up (~11.7s of
    // attempts). One cheap GET per attempt; only fires while the read keeps
    // failing — a success or a real `false` ends it immediately.
    const delays = [400, 800, 1500, 3000, 6000];
    let attempt = 0;
    const run = () => {
      void fetchFlag(controller.signal).then((value) => {
        if (cancelled) return;
        if (value === null) {
          if (attempt < delays.length) {
            const wait = delays[attempt];
            attempt += 1;
            window.setTimeout(() => {
              if (!cancelled) run();
            }, wait);
          }
          return;
        }
        cache.value = value;
        setFlag(value);
      });
    };
    run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fetchFlag, cache]);
  return flag;
}
