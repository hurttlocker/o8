'use client';

/**
 * EntitlementProvider — client-side entitlement state.
 *
 * Fetches GET /api/panel/entitlement once on mount and exposes the resolved
 * plan + flags (+ cosmetic founder status) to the dashboard tree. Modeled on
 * src/lib/theme/context.tsx (createContext + provider + hook). The /api/panel/*
 * route is loopback-gated in src/middleware.ts; the Tauri webview runs
 * same-origin so a plain relative fetch passes the gate — no auth header to add.
 *
 * Defaults to free + loading=true until the fetch resolves, and falls back to
 * free if the fetch fails (never crashes the dashboard). It also re-fetches on a
 * `o8:entitlement-refresh` window event, which the sign-in sync dispatches after
 * applying a founder/subscription license, so the UI flips without a reload. No
 * feature is gated here — this is the rendering layer only (M2).
 */

import {
  createContext,
  useCallback,
  useContext,
  useState,
  useEffect,
  useMemo,
} from 'react';

import { resolveFlags } from './flags';
import type { EntitlementFlags, FounderInfo, Plan } from './types';

interface EntitlementContextValue {
  plan: Plan;
  flags: EntitlementFlags;
  isPro: boolean;
  isTeam: boolean;
  /** Founding Operator status (cosmetic) — null unless this account is a founder. */
  founder: FounderInfo | null;
  loading: boolean;
}

const FREE_FLAGS = resolveFlags('free');

const EntitlementContext = createContext<EntitlementContextValue>({
  plan: 'free',
  flags: FREE_FLAGS,
  isPro: false,
  isTeam: false,
  founder: null,
  loading: true,
});

export function useEntitlement() {
  return useContext(EntitlementContext);
}

interface FounderResponse {
  operatorNumber?: unknown;
  creditUsd?: unknown;
  rateLockUsd?: unknown;
}

interface EntitlementResponse {
  plan?: unknown;
  flags?: unknown;
  source?: unknown;
  founder?: FounderResponse | null;
}

function coercePlan(value: unknown): Plan {
  return value === 'pro' || value === 'team' ? value : 'free';
}

function coerceFounder(value: unknown): FounderInfo | null {
  if (!value || typeof value !== 'object') return null;
  const f = value as FounderResponse;
  if (typeof f.operatorNumber !== 'number') return null;
  return {
    operatorNumber: f.operatorNumber,
    creditUsd: typeof f.creditUsd === 'number' ? f.creditUsd : null,
    rateLockUsd: typeof f.rateLockUsd === 'number' ? f.rateLockUsd : null,
  };
}

export function EntitlementProvider({ children }: { children: React.ReactNode }) {
  const [plan, setPlan] = useState<Plan>('free');
  const [flags, setFlags] = useState<EntitlementFlags>(FREE_FLAGS);
  const [founder, setFounder] = useState<FounderInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/panel/entitlement', { cache: 'no-store' });
      if (!res.ok) throw new Error(`entitlement fetch failed: ${res.status}`);
      const data = (await res.json()) as EntitlementResponse;
      const nextPlan = coercePlan(data.plan);
      setPlan(nextPlan);
      // Re-derive flags from the plan so the client always agrees with the
      // single source of truth (flags.ts), even if the payload is partial.
      setFlags(resolveFlags(nextPlan));
      setFounder(coerceFounder(data.founder));
      // First-run: no token yet (source 'default') → issue a free account token
      // in the background so this install has a stable `sub` for usage
      // attribution + can reach the managed proxy. Idempotent + fail-soft.
      if (data.source === 'default') {
        void fetch('/api/panel/entitlement/bootstrap', { method: 'POST' }).catch(() => {});
      }
    } catch (error) {
      // Never crash the dashboard — fall back to free.
      console.error('[entitlement] client fetch failed, defaulting to free:', error);
      setPlan('free');
      setFlags(FREE_FLAGS);
      setFounder(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load.
  useEffect(() => {
    void load();
  }, [load]);

  // Re-pull when the entitlement changes underneath us (e.g. after the sign-in
  // sync applies a founder/subscription license) so the UI flips live.
  useEffect(() => {
    const onRefresh = () => {
      void load();
    };
    window.addEventListener('o8:entitlement-refresh', onRefresh);
    return () => window.removeEventListener('o8:entitlement-refresh', onRefresh);
  }, [load]);

  const value = useMemo<EntitlementContextValue>(
    () => ({
      plan,
      flags,
      isPro: plan === 'pro' || plan === 'team',
      isTeam: plan === 'team',
      founder,
      loading,
    }),
    [plan, flags, founder, loading],
  );

  return (
    <EntitlementContext.Provider value={value}>{children}</EntitlementContext.Provider>
  );
}
