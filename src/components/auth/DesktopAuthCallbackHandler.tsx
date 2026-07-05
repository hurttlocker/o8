'use client';

import { useEffect, useRef } from 'react';
import { useSignIn, useClerk } from '@clerk/nextjs';

import { O8_AUTH_STATE_KEY } from '@/lib/auth/start-desktop-sign-in';
import { consumeDesktopAuthCallback } from '@/lib/auth/desktop-auth-callback';

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
  const clerk = useClerk();
  // Keep the latest future-resource in a ref so the listener can be installed
  // once on mount and always act on the current sign-in object.
  const signInRef = useRef(signIn);
  signInRef.current = signIn;
  const clerkRef = useRef(clerk);
  clerkRef.current = clerk;
  const processingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const handleUrl = async (raw: string) => {
      if (processingRef.current) return;
      const si = signInRef.current;
      if (!si) return;

      processingRef.current = true;
      try {
        await consumeDesktopAuthCallback(raw, {
          signIn: si,
          clerk: clerkRef.current,
          getExpectedState: () => {
            // CSRF: the echoed state must match the nonce we stored at launch.
            try {
              return sessionStorage.getItem(O8_AUTH_STATE_KEY);
            } catch {
              return null;
            }
          },
          clearExpectedState: () => {
            try {
              sessionStorage.removeItem(O8_AUTH_STATE_KEY);
            } catch {
              /* ignore */
            }
          },
        });
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
