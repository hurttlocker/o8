'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ClerkProvider, useUser, useClerk } from '@clerk/nextjs';
import { startDesktopSignIn } from '@/lib/auth/start-desktop-sign-in';
import { DesktopAuthCallbackHandler } from '@/components/auth/DesktopAuthCallbackHandler';
import { highResolutionAvatarUrl } from '@/lib/auth/avatar-url';
import { installTauriClerkFetchGuard } from '@/lib/auth/clerk-fetch-guard';
import { purgeTauriClerkStore, shouldPurgeClerkStoreForEntitlementSync } from '@/lib/auth/tauri-clerk-store';

// The Clerk publishable key is app-wide and public, baked into the build at ship
// time. When it's absent (fresh build with no Clerk app yet), Clerk is disabled
// and o8 boots fully account-less — sign-in is optional by design.
const CLERK_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const CLERK_ENABLED = Boolean(CLERK_PUBLISHABLE_KEY);

export interface O8AuthUser {
  /** Clerk user id */
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface O8AuthState {
  /** Whether Clerk is configured in this build at all. */
  clerkEnabled: boolean;
  /** Clerk finished resolving its session state. */
  isLoaded: boolean;
  signedIn: boolean;
  user: O8AuthUser | null;
  /** Kick off the desktop sign-in handoff (opens the system browser). */
  signIn: () => void;
  /** Open Clerk's account-management modal ("Manage account"). */
  openManageAccount: () => void;
  /** End the current session. */
  signOut: () => Promise<void>;
}

const DISABLED_STATE: O8AuthState = {
  clerkEnabled: false,
  isLoaded: true,
  signedIn: false,
  user: null,
  signIn: () => {
    console.warn('[auth] sign-in requested but Clerk is not configured in this build');
  },
  openManageAccount: () => {},
  signOut: async () => {},
};

const O8AuthContext = createContext<O8AuthState>(DISABLED_STATE);

interface EntitlementSyncResult {
  ok?: boolean;
  plan?: string;
  reason?: string;
}

/**
 * The single shared auth hook for BOTH the default dashboard and the canvas
 * surface. Reads from O8AuthContext, so consumers never call Clerk hooks
 * directly and work unchanged whether or not Clerk is configured.
 */
export function useO8Auth(): O8AuthState {
  return useContext(O8AuthContext);
}

/**
 * Bridges Clerk's hooks into O8AuthContext. Only mounted when Clerk is enabled
 * (i.e. inside <ClerkProvider>), so the Clerk hooks always have their provider.
 */
function ClerkAuthBridge({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, user } = useUser();
  const clerk = useClerk();
  const provisionedRef = useRef<string | null>(null);
  const syncAbortRef = useRef<AbortController | null>(null);
  // Wall-clock of the last entitlement-sync ATTEMPT. Gates the focus re-sync so
  // a window that regains focus only re-pulls the plan when it's genuinely stale
  // (>15min), never on every focus. Stamped at attempt time so a failed sync
  // can't spin a hot loop (#1519).
  const lastEntitlementSyncRef = useRef(0);

  const clearSignedOutEntitlement = useCallback(async () => {
    syncAbortRef.current?.abort();
    window.dispatchEvent(new CustomEvent('o8:entitlement-refresh', {
      detail: { signedOut: true },
    }));
    await fetch('/api/panel/entitlement/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedOut: true }),
    }).catch(() => {});
  }, []);

  // Pull THIS account's license from the license server and cache it locally so
  // the plan flips without a reload. Shared by the sign-in effect and the
  // focus re-sync. Best-effort + fail-soft — NEVER downgrades a cached license
  // (the route's #1483 cached-license behavior governs that); failure is
  // silent-with-console-log. On a non-free result we nudge EntitlementProvider
  // to re-fetch live.
  // NATIVE-MODE SEAM (live-hit 2026-07-05): the desktop Clerk session lives in
  // the Tauri store, NOT in cookies — server-side auth() sees nothing, so the
  // client must forward its own short-lived session token. The license server
  // verifies it against the Clerk JWKS either way; this header is just transport.
  const runEntitlementSync = useCallback(
    async (activeUser: { id: string }, signal?: AbortSignal) => {
      // Stamp at attempt time — rate-limits the focus re-sync regardless of outcome.
      lastEntitlementSyncRef.current = Date.now();
      try {
        const sessionToken = await Promise.resolve(clerk.session?.getToken() ?? null).catch(
          () => null,
        );
        const res = await fetch('/api/panel/entitlement/sync', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(sessionToken ? { 'x-clerk-session-token': sessionToken } : {}),
          },
          body: JSON.stringify({ clerkUserId: activeUser.id }),
          signal,
        });
        const data = (await res.json().catch(() => null)) as EntitlementSyncResult | null;
        if (shouldPurgeClerkStoreForEntitlementSync(data?.reason)) {
          void purgeTauriClerkStore();
          void clearSignedOutEntitlement();
          return;
        }
        if (data?.ok && data.plan && data.plan !== 'free') {
          window.dispatchEvent(new Event('o8:entitlement-refresh'));
        }
      } catch (err) {
        // Aborted (user change / sign-out) or transient — never blocks the UI and
        // never downgrades; entitlement re-reads on the next mount / focus.
        if ((err as { name?: string })?.name !== 'AbortError') {
          console.log('[entitlement] account sync skipped:', (err as Error)?.message ?? err);
        }
      }
    },
    [clerk, clearSignedOutEntitlement],
  );

  // Mirror the active Clerk user into the local users table, once per user.
  // The route re-derives the authoritative id from the verified session.
  useEffect(() => {
    if (!isSignedIn || !user) {
      provisionedRef.current = null;
      return;
    }
    if (provisionedRef.current === user.id) return;
    provisionedRef.current = user.id;
    const controller = new AbortController();
    syncAbortRef.current?.abort();
    syncAbortRef.current = controller;
    const githubId = user.externalAccounts?.find((a) => String(a.provider).includes('github'))?.providerUserId;
    const avatarUrl = highResolutionAvatarUrl(user.imageUrl);
    void fetch('/api/panel/auth/clerk-provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clerkUserId: user.id,
        githubId,
        email: user.primaryEmailAddress?.emailAddress ?? null,
        name: user.fullName ?? user.username ?? null,
        avatarUrl,
      }),
    }).catch(() => {
      /* provisioning is best-effort; getCurrentUser retries on next sign-in */
    });

    // Authoritative sign-in sync — always runs (the 15-min gate is focus-only).
    void runEntitlementSync(user, controller.signal);
    return () => {
      controller.abort();
    };
  }, [isSignedIn, user, runEntitlementSync]);

  // Re-sync on window focus when the cached entitlement is stale (>15min). The
  // desktop otherwise only learns a plan change at sign-in, so an app left open
  // for hours never sees an upgrade/downgrade land. Debounced, best-effort, and
  // never blocks the UI; the shared runEntitlementSync never downgrades a cached
  // license (#1519 / #1483).
  useEffect(() => {
    if (!isSignedIn || !user) return;
    const STALE_MS = 15 * 60 * 1000;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const maybeResync = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (Date.now() - lastEntitlementSyncRef.current < STALE_MS) return;
      if (debounce) return; // already scheduled this focus burst
      debounce = setTimeout(() => {
        debounce = null;
        if (Date.now() - lastEntitlementSyncRef.current < STALE_MS) return;
        const controller = new AbortController();
        syncAbortRef.current?.abort();
        syncAbortRef.current = controller;
        void runEntitlementSync(user, controller.signal);
      }, 400);
    };

    const onFocus = () => maybeResync();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') maybeResync();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      if (debounce) clearTimeout(debounce);
    };
  }, [isSignedIn, user, runEntitlementSync]);

  const value = useMemo<O8AuthState>(
    () => ({
      clerkEnabled: true,
      isLoaded,
      signedIn: Boolean(isSignedIn),
      user: user
        ? {
            id: user.id,
            name: user.fullName ?? user.username ?? null,
            email: user.primaryEmailAddress?.emailAddress ?? null,
            avatarUrl: highResolutionAvatarUrl(user.imageUrl),
          }
        : null,
      signIn: startDesktopSignIn,
      openManageAccount: () => {
        clerk.openUserProfile();
      },
      signOut: async () => {
        await purgeTauriClerkStore();
        await clearSignedOutEntitlement();
        await clerk.signOut();
        await purgeTauriClerkStore();
        await clearSignedOutEntitlement();
      },
    }),
    [isLoaded, isSignedIn, user, clerk, clearSignedOutEntitlement],
  );

  return (
    <O8AuthContext.Provider value={value}>
      <DesktopAuthCallbackHandler />
      {children}
    </O8AuthContext.Provider>
  );
}

/**
 * Root auth provider. Wraps the whole app in src/app/layout.tsx so both the
 * dashboard and canvas routes share one identity. No-op (account-less) when no
 * Clerk key is baked into the build.
 */
export function O8AuthProvider({ children }: { children: ReactNode }) {
  if (!CLERK_ENABLED) {
    return <O8AuthContext.Provider value={DISABLED_STATE}>{children}</O8AuthContext.Provider>;
  }
  return <ClerkSessionHost>{children}</ClerkSessionHost>;
}

// Type only — the runtime import is deferred into the effect below so Next's
// static build never evaluates the plugin's Tauri APIs (no Tauri at build time).
type NativeClerk = Awaited<ReturnType<(typeof import('tauri-plugin-clerk'))['initClerk']>>;

/**
 * Picks the Clerk session engine per surface:
 *  - Tauri desktop → NATIVE mode via tauri-plugin-clerk: clerk-js runs with
 *    standardBrowser:false, routes the Frontend API through Rust, and persists
 *    the session token to a Tauri store on disk. REQUIRED because a PRODUCTION
 *    Clerk instance keeps its session in a cross-site cookie that macOS WKWebView
 *    won't return to the 127.0.0.1 webview origin — so the standard cookie flow
 *    flashes the session in then drops it. (Root-fixed 2026-07-05; see
 *    docs/onboarding-auth-unification.md.)
 *  - Web / mobile → standard cookie mode (same-origin with the real o8.run domain).
 * Until the native engine resolves, the app boots account-less (DISABLED_STATE),
 * never blocking startup.
 */
function ClerkSessionHost({ children }: { children: ReactNode }) {
  const [engine, setEngine] = useState<NativeClerk | 'web' | null>(null);

  useEffect(() => {
    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (!isTauri) {
      setEngine('web');
      return;
    }
    let active = true;
    const nativeFetch = globalThis.fetch;
    // Client-only dynamic import — the plugin touches Tauri globals, so it must
    // never load during Next's SSR/static export.
    import('tauri-plugin-clerk')
      .then((m) => m.initClerk())
      .then((clerk) => {
        installTauriClerkFetchGuard(nativeFetch);
        if (active) setEngine(clerk);
      })
      .catch((err) => {
        // Fail-soft: if the native engine can't init, fall back to cookie mode so
        // the app still boots (sign-in just won't persist on desktop).
        console.error('[auth] native Clerk init failed; using cookie mode', err);
        if (active) setEngine('web');
      });
    return () => {
      active = false;
    };
  }, []);

  if (engine === null) {
    return <O8AuthContext.Provider value={DISABLED_STATE}>{children}</O8AuthContext.Provider>;
  }

  if (engine === 'web') {
    return (
      <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
        <ClerkAuthBridge>{children}</ClerkAuthBridge>
      </ClerkProvider>
    );
  }

  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} Clerk={engine}>
      <ClerkAuthBridge>{children}</ClerkAuthBridge>
    </ClerkProvider>
  );
}
