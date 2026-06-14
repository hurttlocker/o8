'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { ClerkProvider, useUser, useClerk } from '@clerk/nextjs';
import { startDesktopSignIn } from '@/lib/auth/start-desktop-sign-in';

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
            avatarUrl: user.imageUrl ?? null,
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

  return <O8AuthContext.Provider value={value}>{children}</O8AuthContext.Provider>;
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
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
      <ClerkAuthBridge>{children}</ClerkAuthBridge>
    </ClerkProvider>
  );
}
