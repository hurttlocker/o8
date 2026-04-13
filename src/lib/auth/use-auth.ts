/**
 * useAuth — Client-side auth hook for Cortex IDE
 *
 * Auth uses httpOnly cookie only (set by server on login).
 * localStorage stores user profile for fast hydration — NOT the JWT token.
 * The cookie is auto-sent with every same-origin request.
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

// ── Types ──

export interface AuthUser {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  plan: string;
  githubUsername?: string;
}

export interface AuthState {
  /** Is the user authenticated? */
  isAuthenticated: boolean;
  /** Is auth state still loading? */
  isLoading: boolean;
  /** The authenticated user (null if not signed in) */
  user: AuthUser | null;
  /** Sign in — stores user profile (token is in httpOnly cookie, set by server) */
  signIn: (token: string, user: AuthUser) => void;
  /** Sign out */
  signOut: () => Promise<void>;
  /** Refresh user profile from server */
  refresh: () => Promise<void>;
}

// ── Constants ──

const USER_KEY = 'o8-user';

// ── Hook ──

export function useAuth(): AuthState {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const verifiedRef = useRef(false);

  // Load cached user profile for fast hydration, then verify with server
  useEffect(() => {
    // Fast hydration from localStorage (user profile only, never the token)
    try {
      const savedUser = localStorage.getItem(USER_KEY);
      if (savedUser) {
        setUser(JSON.parse(savedUser));
      }
    } catch {
      localStorage.removeItem(USER_KEY);
    }
    setIsLoading(false);

    // Verify auth cookie is still valid on mount (non-blocking)
    if (!verifiedRef.current) {
      verifiedRef.current = true;
      fetch('/api/v2/auth/session', { credentials: 'same-origin' })
        .then(async (res) => {
          if (res.ok) {
            const data = await res.json();
            if (data.user) {
              setUser(data.user);
              localStorage.setItem(USER_KEY, JSON.stringify(data.user));
            }
          } else if (res.status === 401) {
            // Cookie expired or invalid — clear cached user
            setUser(null);
            localStorage.removeItem(USER_KEY);
          }
        })
        .catch(() => { /* network error — keep cached state */ });
    }
  }, []);

  const signIn = useCallback((_token: string, newUser: AuthUser) => {
    // Token is already set as httpOnly cookie by the server response.
    // We only store user profile for UI hydration.
    setUser(newUser);
    localStorage.setItem(USER_KEY, JSON.stringify(newUser));
    // Migrate: remove any legacy token from localStorage
    localStorage.removeItem('o8-token');
  }, []);

  const signOut = useCallback(async () => {
    setUser(null);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem('o8-token'); // clean up legacy

    // Clear server-side cookie + session
    try {
      await fetch('/api/v2/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {
      // Ignore — cookie may already be gone
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/v2/auth/session', { credentials: 'same-origin' });

      if (res.ok) {
        const data = await res.json();
        if (data.user) {
          setUser(data.user);
          localStorage.setItem(USER_KEY, JSON.stringify(data.user));
        }
      } else if (res.status === 401) {
        // Token expired — sign out
        setUser(null);
        localStorage.removeItem(USER_KEY);
      }
    } catch {
      // Network error — keep current state
    }
  }, []);

  return {
    isAuthenticated: !!user,
    isLoading,
    user,
    signIn,
    signOut,
    refresh,
  };
}
