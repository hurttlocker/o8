'use client';

import { useEffect, useRef } from 'react';
import { useSignIn } from '@clerk/nextjs';

import { O8_AUTH_STATE_KEY } from '@/lib/auth/start-desktop-sign-in';

/**
 * Consumes the `o8://auth/callback?ticket=...&state=...` deep link that the Tauri
 * shell surfaces (live `o8:auth-callback` event + `take_pending_auth_callbacks`
 * cold-start buffer): verifies the CSRF state, exchanges the one-time Clerk ticket
 * for a session, and finalizes it.
 *
 * Uses the @clerk/nextjs 7.x signals/futures API — `useSignIn()` returns a
 * `SignInFutureResource` whose `ticket()` performs ticket sign-in and `finalize()`
 * activates the session (which makes useUser() update; the bridge then provisions
 * the local user row). Mounted inside ClerkProvider; renders nothing.
 */
export function DesktopAuthCallbackHandler() {
  const { signIn } = useSignIn();
  // Keep the latest future-resource in a ref so the listener can be installed
  // once on mount and always act on the current sign-in object.
  const signInRef = useRef(signIn);
  signInRef.current = signIn;
  const processingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const handleUrl = async (raw: string) => {
      if (processingRef.current) return;
      const si = signInRef.current;
      if (!si) return;

      let ticket: string | null = null;
      let state: string | null = null;
      try {
        const u = new URL(raw);
        if (u.protocol !== 'o8:' || u.host !== 'auth') return;
        ticket = u.searchParams.get('ticket');
        state = u.searchParams.get('state');
      } catch {
        return;
      }
      if (!ticket) return;

      // CSRF: the echoed state must match the nonce we stored at launch.
      let expected: string | null = null;
      try {
        expected = sessionStorage.getItem(O8_AUTH_STATE_KEY);
      } catch {
        /* storage unavailable — skip the check rather than block sign-in */
      }
      if (expected && state !== expected) {
        console.warn('[auth] callback state mismatch — ignoring');
        return;
      }

      processingRef.current = true;
      try {
        const { error } = await si.ticket({ ticket });
        if (error) {
          console.error('[auth] ticket sign-in failed:', error);
          return;
        }
        if (si.status === 'complete') {
          const { error: finalizeError } = await si.finalize();
          if (finalizeError) {
            console.error('[auth] finalize failed:', finalizeError);
            return;
          }
          try {
            sessionStorage.removeItem(O8_AUTH_STATE_KEY);
          } catch {
            /* ignore */
          }
        } else {
          console.warn('[auth] ticket sign-in incomplete:', si.status);
        }
      } catch (err) {
        console.error('[auth] ticket exchange threw:', err);
      } finally {
        processingRef.current = false;
      }
    };

    // Hot path: live deep-link event from the Tauri shell.
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<string[]>('o8:auth-callback', (event) => {
          if (cancelled) return;
          for (const url of event.payload || []) void handleUrl(url);
        }),
      )
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch(() => {
        /* not running under Tauri */
      });

    // Cold-start path: drain callbacks buffered before this mounted.
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<string[]>('take_pending_auth_callbacks'))
      .then((urls) => {
        if (cancelled) return;
        for (const url of urls || []) void handleUrl(url);
      })
      .catch(() => {
        /* not running under Tauri */
      });

    return () => {
      cancelled = true;
      if (unlisten) {
        try {
          unlisten();
        } catch {
          /* noop */
        }
      }
    };
  }, []);

  return null;
}
