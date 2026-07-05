'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ClerkProvider, useUser, useClerk } from '@clerk/nextjs';
import { startDesktopSignIn } from '@/lib/auth/start-desktop-sign-in';
import { DesktopAuthCallbackHandler } from '@/components/auth/DesktopAuthCallbackHandler';
import { highResolutionAvatarUrl } from '@/lib/auth/avatar-url';

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

  // Mirror the active Clerk user into the local users table, once per user.
  // The route re-derives the authoritative id from the verified session.
  useEffect(() => {
    if (!isSignedIn || !user) return;
    if (provisionedRef.current === user.id) return;
    provisionedRef.current = user.id;
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

    // Pull this account's license (Founding Operator / subscription) and cache
    // it locally so the plan flips without a reload. Best-effort + fail-soft;
    // on a non-free result we nudge EntitlementProvider to re-fetch live.
    // NATIVE-MODE SEAM (live-hit 2026-07-05): the desktop Clerk session lives in
    // the Tauri store, NOT in cookies — server-side auth() sees nothing, so the
    // client must forward its own short-lived session token. The license server
    // verifies it against the Clerk JWKS either way; this header is just
    // transport. Web/cookie mode keeps working without it.
    void Promise.resolve(clerk.session?.getToken() ?? null)
      .catch(() => null)
      .then((sessionToken) => fetch('/api/panel/entitlement/sync', {
        method: 'POST',
        headers: sessionToken ? { 'x-clerk-session-token': sessionToken } : {},
      }))
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { ok?: boolean; plan?: string } | null) => {
        if (d?.ok && d.plan && d.plan !== 'free') {
          window.dispatchEvent(new Event('o8:entitlement-refresh'));
        }
      })
      .catch(() => {
        /* sync is best-effort; entitlement re-reads on next mount */
      });
  }, [isSignedIn, user]);

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
        await clerk.signOut();
      },
    }),
    [isLoaded, isSignedIn, user, clerk],
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
    // Client-only dynamic import — the plugin touches Tauri globals, so it must
    // never load during Next's SSR/static export.
    import('tauri-plugin-clerk')
      .then((m) => m.initClerk())
      .then((clerk) => {
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
