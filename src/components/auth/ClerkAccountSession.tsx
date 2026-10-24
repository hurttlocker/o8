'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ClerkProvider, useUser, useClerk, useSignIn } from '@clerk/nextjs';
import { DesktopAuthCallbackHandler } from '@/components/auth/DesktopAuthCallbackHandler';
import { accountIdentity } from '@/lib/auth/account-identity';
import { openAccountSettings } from '@/lib/auth/open-account-settings';
import { purgeTauriClerkStore, shouldPurgeClerkStoreForEntitlementSync } from '@/lib/auth/tauri-clerk-store';
import { scheduleManagedGithubRefresh } from '@/lib/github-broker/refresh-schedule';
import { desktopAuthTicketExchangeInProgress, invalidateDesktopAuthHandoffs, subscribeDesktopAuthTicketExchange, subscribeDesktopBrowserSignIn, waitForDesktopAuthTicketExchange } from '@/lib/auth/desktop-auth-callback';
import { completeDesktopSignIn, DEVICE_RETRY_MS, deviceSessionDecision, renewDesktopSession, type DeviceSessionTrigger } from '@/lib/auth/device-session-client';
import { canUseTauriEvents } from '@/lib/tauri/bridge';
import { registerPlanAccountToken } from '@/lib/chatgpt-plan/client';
import { DesktopSignInDialog } from './DesktopSignInDialog';
import { clerkAppearance } from './clerk-appearance';
import type { O8AuthState } from './O8AuthProvider';

const enrolledDeviceUsers = new Set<string>();
const CLERK_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
type NativeClerk = Awaited<ReturnType<(typeof import('tauri-plugin-clerk'))['initClerk']>>;

interface EntitlementSyncResult {
  ok?: boolean;
  plan?: string;
  reason?: string;
}

/**
 * Bridges Clerk's hooks into O8AuthContext. Only mounted when Clerk is enabled
 * (i.e. inside <ClerkProvider>), so the Clerk hooks always have their provider.
 */
function ClerkAuthBridge({ onAuthChange, nativeMode = false }: { onAuthChange: (auth: O8AuthState) => void; nativeMode?: boolean }) {
  const deviceMode = nativeMode && canUseTauriEvents();
  const { isLoaded, isSignedIn, user } = useUser();
  const clerk = useClerk();
  const { signIn } = useSignIn();
  const [signInPrompt, setSignInPrompt] = useState(false);
  useEffect(() => {
    if (!isSignedIn) return;
    // Clear the launcher after success so a later sign-out cannot reopen it.
    queueMicrotask(() => setSignInPrompt(false));
  }, [isSignedIn]);
  const ticketExchanging = useSyncExternalStore(
    subscribeDesktopAuthTicketExchange, desktopAuthTicketExchangeInProgress, () => false,
  );
  const [deviceRenewing, setDeviceRenewing] = useState(false);
  const deviceRenewingRef = useRef(false);
  const explicitSignOutRef = useRef(false);
  const signOutInProgressRef = useRef(0);
  const deviceGenerationRef = useRef(0);
  const deviceRetryAfterRef = useRef(0);
  const deviceAttemptRef = useRef<Promise<void> | null>(null);
  const pendingDeviceTriggerRef = useRef<DeviceSessionTrigger | null>(null);
  const previousUserRef = useRef<string | null>(null);
  const authRef = useRef({ isLoaded, isSignedIn, user, clerk, signIn });
  authRef.current = { isLoaded, isSignedIn, user, clerk, signIn };
  useEffect(() => registerPlanAccountToken(async () => {
    const current = authRef.current;
    if (!current.isSignedIn || explicitSignOutRef.current || !current.user) return null;
    return await current.clerk.session?.getToken() ?? null;
  }), [clerk, isSignedIn, user?.id]);
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

  const fullSignOut = useCallback(async (waitForDeviceAttempt = false) => {
    if (nativeMode) {
      invalidateDesktopAuthHandoffs();
      signOutInProgressRef.current += 1;
      explicitSignOutRef.current = true;
      deviceGenerationRef.current += 1;
      // Renewal may be signed out or have activated a mismatching user. Reset
      // the enrollment history for the revoked device owner as well.
      enrolledDeviceUsers.clear();
      pendingDeviceTriggerRef.current = null;
    }
    try {
      if (nativeMode) {
        const revoke = await fetch('/api/panel/auth/device/revoke', { method: 'POST' }).catch(() => null);
        if (!revoke?.ok || (await revoke.json().catch(() => null))?.ok !== true) {
          const cancelled = await fetch('/api/panel/auth/handoff?action=cancel', { method: 'POST' }).catch(() => null);
          if (!cancelled?.ok || (await cancelled.json().catch(() => null))?.ok !== true) {
            throw new Error('Sign-out could not be saved. Try again.');
          }
        }
        // Neither a browser nor a device ticket already inside Clerk can be
        // aborted. End that session after activation settles.
        if (waitForDeviceAttempt) {
          await deviceAttemptRef.current?.catch(() => {});
          await waitForDesktopAuthTicketExchange();
        }
      }
      await purgeTauriClerkStore();
      await clearSignedOutEntitlement();
      try {
        await clerk.signOut();
      } finally {
        await purgeTauriClerkStore();
        await clearSignedOutEntitlement();
      }
    } finally {
      if (nativeMode) signOutInProgressRef.current -= 1;
    }
  }, [nativeMode, clerk, clearSignedOutEntitlement]);

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
    async (activeUser: { id: string }, signal?: AbortSignal, afterSignIn = false) => {
      if (nativeMode && desktopAuthTicketExchangeInProgress() && !afterSignIn) return;
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
          if (nativeMode) await fullSignOut();
          else {
            void purgeTauriClerkStore();
            void clearSignedOutEntitlement();
          }
          return;
        }
        if (data?.ok && data.plan && data.plan !== 'free') {
          window.dispatchEvent(new Event('o8:entitlement-refresh'));
        }
      } catch (err) {
        // Aborted (user change / sign-out) or transient — never blocks the UI and
        // never downgrades; entitlement re-reads on the next mount / focus.
        if ((err as { name?: string })?.name !== 'AbortError') {
          console.log('[entitlement] account sync skipped');
        }
      }
    },
    [clerk, clearSignedOutEntitlement, nativeMode, fullSignOut],
  );

  const attemptDeviceSession = useCallback((trigger: DeviceSessionTrigger): void => {
    if (!deviceMode || !authRef.current.isLoaded || explicitSignOutRef.current || signOutInProgressRef.current
      || Date.now() < deviceRetryAfterRef.current) return;
    if (deviceAttemptRef.current) {
      pendingDeviceTriggerRef.current = trigger;
      return;
    }
    if (desktopAuthTicketExchangeInProgress()) return;
    const generation = deviceGenerationRef.current;
    const isCurrent = () => generation === deviceGenerationRef.current && !explicitSignOutRef.current;
    const attempt = async () => {
      try {
        const statusResponse = await fetch('/api/panel/auth/device/status', { cache: 'no-store' });
        if (!statusResponse.ok) throw new Error('Device status unavailable.');
        const status = await statusResponse.json();
        if (!isCurrent() || desktopAuthTicketExchangeInProgress()) return;
        const current = authRef.current;
        const userId = current.isSignedIn ? current.user?.id ?? null : null;
        const owner = status.present && typeof status.clerkUserId === 'string' ? status.clerkUserId : null;
        const decision = deviceSessionDecision({
          nativeMode, loaded: current.isLoaded, userId, deviceOwner: owner,
          explicitSignOut: explicitSignOutRef.current, busy: false,
          enrolled: userId ? enrolledDeviceUsers.has(userId) : false,
          retryAfter: deviceRetryAfterRef.current, now: Date.now(), trigger,
        });
        if (decision === 'enroll' && userId) {
          const sessionToken = await current.clerk.session?.getToken();
          if (!sessionToken || !isCurrent() || desktopAuthTicketExchangeInProgress()) return;
          const response = await fetch('/api/panel/auth/device/enroll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-clerk-session-token': sessionToken },
            body: JSON.stringify({ clerkUserId: userId }),
          });
          if (response.status !== 200) throw new Error('Device enrollment failed.');
          if (isCurrent()) enrolledDeviceUsers.add(userId);
        } else if (decision === 'renew' && owner) {
          if (!current.signIn) throw new Error('Sign-in is not ready.');
          deviceRenewingRef.current = true;
          setDeviceRenewing(true);
          await renewDesktopSession({
            owner, signIn: current.signIn, clerk: current.clerk, isCurrent,
            signOut: () => fullSignOut(),
            onSignInComplete: () => completeDesktopSignIn(async () => {
              // Same fresh-sign-in boundary as the browser callback: retire
              // the marker and bump the managed identity epoch before syncing.
              if (isCurrent()) await runEntitlementSync({ id: owner }, undefined, true);
            }),
          });
        }
      } catch {
        // No raw upstream errors: credentials must never enter renderer logs.
        deviceRetryAfterRef.current = Date.now() + DEVICE_RETRY_MS;
      } finally {
        deviceRenewingRef.current = false;
        setDeviceRenewing(false);
      }
    };
    deviceAttemptRef.current = attempt().finally(() => {
      deviceAttemptRef.current = null;
      const pending = pendingDeviceTriggerRef.current;
      pendingDeviceTriggerRef.current = null;
      if (pending) attemptDeviceSession(pending);
    });
  }, [nativeMode, deviceMode, fullSignOut, runEntitlementSync]);

  useEffect(() => {
    if (!deviceMode) return;
    return subscribeDesktopBrowserSignIn(() => {
      if (signOutInProgressRef.current) return;
      explicitSignOutRef.current = false;
      deviceRetryAfterRef.current = 0;
      enrolledDeviceUsers.clear();
    });
  }, [deviceMode]);

  useEffect(() => {
    if (!deviceMode || !isLoaded) return;
    const nextUser = isSignedIn ? user?.id ?? null : null;
    const priorUser = previousUserRef.current;
    if (nextUser && nextUser !== priorUser && !deviceRenewingRef.current) {
      deviceGenerationRef.current += 1;
    }
    previousUserRef.current = nextUser;
    attemptDeviceSession(priorUser && !nextUser ? 'signed-out' : 'initial');
  }, [deviceMode, isLoaded, isSignedIn, user?.id, attemptDeviceSession, ticketExchanging]);

  useEffect(() => {
    if (!deviceMode) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const onFocus = () => {
      if (document.visibilityState === 'hidden' || debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        attemptDeviceSession('focus');
      }, 400);
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') onFocus(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      if (debounce) clearTimeout(debounce);
    };
  }, [deviceMode, attemptDeviceSession]);

  // Mirror the active Clerk user into the local users table, once per user.
  // The route re-derives the authoritative id from the verified session.
  useEffect(() => {
    if (deviceRenewingRef.current || (nativeMode && desktopAuthTicketExchangeInProgress())) return;
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
    const { email, avatarUrl } = accountIdentity(user);
    void fetch('/api/panel/auth/clerk-provision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clerkUserId: user.id,
        githubId,
        email,
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
  }, [isSignedIn, user, runEntitlementSync, deviceRenewing, nativeMode, ticketExchanging]);

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

  // GitHub App installation tokens expire after one hour. Focus re-sync handles
  // normal window switching, but a continuously focused desktop could otherwise
  // cross the expiry boundary and lose GitHub access until focus changed. Refresh
  // at 50 minutes; the server replaces cached tokens inside its 15-minute window.
  useEffect(() => {
    if (!isSignedIn || !user) return;
    let controller: AbortController | null = null;
    const stop = scheduleManagedGithubRefresh(() => {
      controller = new AbortController();
      syncAbortRef.current?.abort();
      syncAbortRef.current = controller;
      void runEntitlementSync(user, controller.signal);
    });
    return () => {
      stop();
      controller?.abort();
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
            ...accountIdentity(user),
          }
        : null,
      signIn: () => {
        explicitSignOutRef.current = false;
        deviceRetryAfterRef.current = 0;
        if (nativeMode) enrolledDeviceUsers.clear();
        if (isSignedIn) { openAccountSettings(clerk); return; }
        if (nativeMode) setSignInPrompt(true);
        else clerk.openSignIn({ forceRedirectUrl: window.location.href, signUpForceRedirectUrl: window.location.href });
      },
      openManageAccount: () => openAccountSettings(clerk),
      signOut: () => fullSignOut(true).catch(() => {
        throw new Error('Sign-out failed. Try again.');
      }),
    }),
    [isLoaded, isSignedIn, user, clerk, nativeMode, fullSignOut],
  );

  useLayoutEffect(() => { onAuthChange(value); }, [onAuthChange, value]);

  return (
    <>
      <DesktopAuthCallbackHandler />
      {signInPrompt && !isSignedIn ? <DesktopSignInDialog onClose={() => setSignInPrompt(false)} /> : null}
    </>
  );
}

// Publishing account state must not re-render the publishing SDK subtree. Clerk's
// own context updates still reach the bridge independently of workspace updates.
export const ClerkAccountSession = memo(function ClerkAccountSession({ engine, onAuthChange }: {
  engine: NativeClerk | 'web';
  onAuthChange: (auth: O8AuthState) => void;
}) {
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} Clerk={engine === 'web' ? undefined : engine} appearance={clerkAppearance}>
      <ClerkAuthBridge nativeMode={engine !== 'web'} onAuthChange={onAuthChange} />
    </ClerkProvider>
  );
});
