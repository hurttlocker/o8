/**
 * useAuth — Client-side auth hook for Cortex IDE
 *
 * Manages JWT token storage and provides auth state to components.
 * Token is stored in localStorage (for API calls) AND httpOnly cookie (for SSR).
 */

'use client';

import { useState, useEffect, useCallback } from 'react';

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
  /** JWT token (null if not signed in) */
  token: string | null;
  /** Sign in with a token (called after device flow completes) */
  signIn: (token: string, user: AuthUser) => void;
  /** Sign out */
  signOut: () => Promise<void>;
  /** Refresh user profile from server */
  refresh: () => Promise<void>;
}

// ── Constants ──

const TOKEN_KEY = 'cortex-ide-token';
const USER_KEY = 'cortex-ide-user';

// ── Hook ──

export function useAuth(): AuthState {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load saved auth on mount
  useEffect(() => {
    try {
      const savedToken = localStorage.getItem(TOKEN_KEY);
      const savedUser = localStorage.getItem(USER_KEY);

      if (savedToken && savedUser) {
        setToken(savedToken);
        setUser(JSON.parse(savedUser));
      }
    } catch {
      // Corrupted localStorage — clear it
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    }
    setIsLoading(false);
  }, []);

  const signIn = useCallback((newToken: string, newUser: AuthUser) => {
    setToken(newToken);
    setUser(newUser);
    localStorage.setItem(TOKEN_KEY, newToken);
    localStorage.setItem(USER_KEY, JSON.stringify(newUser));
  }, []);

  const signOut = useCallback(async () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);

    // Clear server-side cookie
    try {
      await fetch('/api/v2/auth/logout', { method: 'POST' });
    } catch {
      // Ignore — cookie may already be gone
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!token) return;

    try {
      const res = await fetch('/api/v2/auth/session', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        const data = await res.json();
        if (data.user) {
          setUser(data.user);
          localStorage.setItem(USER_KEY, JSON.stringify(data.user));
        }
      } else if (res.status === 401) {
        // Token expired — sign out
        await signOut();
      }
    } catch {
      // Network error — keep current state
    }
  }, [token, signOut]);

  return {
    isAuthenticated: !!token && !!user,
    isLoading,
    user,
    token,
    signIn,
    signOut,
    refresh,
  };
}

/**
 * Get auth headers for API calls.
 * Use this in fetch() calls to v2 API routes.
 */
export function getAuthHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}
