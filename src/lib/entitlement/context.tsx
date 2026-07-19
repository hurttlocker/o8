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

import { useO8Auth } from '@/components/auth/O8AuthProvider';

import { resolveFlags } from './flags';
import type { EntitlementFlags, FounderInfo, Plan } from './types';

interface EntitlementContextValue {
  /** EFFECTIVE plan — after the dev "view-as" min-clamp (#1517). */
  plan: Plan;
  flags: EntitlementFlags;
  isPro: boolean;
  isTeam: boolean;
  /**
   * EFFECTIVE Founding Operator status (cosmetic) — null unless this account is
   * a founder AND no view-as override is downclamping. Feature gates read this
   * so founder surfaces hide faithfully while viewing-as-free.
   */
  founder: FounderInfo | null;
  /** Real plan BEFORE the view-as clamp — for the dev-switch / billing surfaces. */
  actualPlan: Plan;
  /** Real Founding Operator record (never suppressed) — gates the dev switch. */
  actualFounder: FounderInfo | null;
  /** True while a `~/.o8/dev-plan-override` view-as switch is active. */
  overrideActive: boolean;
  loading: boolean;
}

const FREE_FLAGS = resolveFlags('free');

const EntitlementContext = createContext<EntitlementContextValue>({
  plan: 'free',
  flags: FREE_FLAGS,
  isPro: false,
  isTeam: false,
  founder: null,
  actualPlan: 'free',
  actualFounder: null,
  overrideActive: false,
  loading: true,
});

export function useEntitlement() {
  return useContext(EntitlementContext);
}

interface FounderResponse {
  operatorNumber?: unknown;
  tier?: unknown;
}

interface EntitlementResponse {
  plan?: unknown;
  flags?: unknown;
  source?: unknown;
  founder?: FounderResponse | null;
  actualPlan?: unknown;
  actualFounder?: FounderResponse | null;
  overrideActive?: unknown;
}

function coercePlan(value: unknown): Plan {
  return value === 'pro' || value === 'team' || value === 'founder' ? value : 'free';
}

function coerceFounder(value: unknown): FounderInfo | null {
  if (!value || typeof value !== 'object') return null;
  const f = value as FounderResponse;
  if (typeof f.operatorNumber !== 'number') return null;
  return {
    operatorNumber: f.operatorNumber,
    tier: typeof f.tier === 'number' ? f.tier : null,
  };
}

export function shouldUseSignedOutEntitlement(input: {
  clerkEnabled: boolean;
  isLoaded: boolean;
  signedIn: boolean;
}): boolean {
  return input.clerkEnabled && input.isLoaded && !input.signedIn;
}

export function isSignedOutEntitlementRefresh(detail: unknown): boolean {
  return Boolean(detail && typeof detail === 'object' && (detail as { signedOut?: unknown }).signedOut === true);
}

export function EntitlementProvider({ children }: { children: React.ReactNode }) {
  const [plan, setPlan] = useState<Plan>('free');
  const [flags, setFlags] = useState<EntitlementFlags>(FREE_FLAGS);
  const [founder, setFounder] = useState<FounderInfo | null>(null);
  const [actualPlan, setActualPlan] = useState<Plan>('free');
  const [actualFounder, setActualFounder] = useState<FounderInfo | null>(null);
  const [overrideActive, setOverrideActive] = useState(false);
  const [loading, setLoading] = useState(true);

  // In desktop native mode server-side auth() can't see the Clerk session (it
  // lives in the Tauri store), so forward the clerk-js-known subject to the GET
  // route as evidence — a genuine cross-user mismatch still drops the cached
  // license, while an unknown subject keeps it (#1483). Null when signed-out /
  // Clerk-disabled / still loading; that path keeps the license by design.
  const auth = useO8Auth();
  const { user } = auth;
  const activeSubject = user?.id ?? null;
  const signedOut = shouldUseSignedOutEntitlement(auth);

  const applyFreeEntitlement = useCallback(() => {
    setPlan('free');
    setFlags(FREE_FLAGS);
    setFounder(null);
    setActualPlan('free');
    setActualFounder(null);
    setOverrideActive(false);
    setLoading(false);
  }, []);

  const load = useCallback(async () => {
    if (signedOut) {
      applyFreeEntitlement();
      return;
    }
    try {
      const url = activeSubject
        ? `/api/panel/entitlement?subject=${encodeURIComponent(activeSubject)}`
        : '/api/panel/entitlement';
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`entitlement fetch failed: ${res.status}`);
      const data = (await res.json()) as EntitlementResponse;
      const nextPlan = coercePlan(data.plan);
      setPlan(nextPlan);
      // Re-derive flags from the plan so the client always agrees with the
      // single source of truth (flags.ts), even if the payload is partial.
      setFlags(resolveFlags(nextPlan));
      setFounder(coerceFounder(data.founder));
      // View-as (#1517): the server already clamped `plan`/`flags`/`founder` to
      // the effective (free) view; keep the real state for the dev-switch gate.
      setActualPlan(coercePlan(data.actualPlan));
      setActualFounder(coerceFounder(data.actualFounder));
      setOverrideActive(data.overrideActive === true);
      // First-run: no token yet (source 'default') → issue a free account token
      // in the background so this install has a stable `sub` for usage
      // attribution + can reach the managed proxy. Idempotent + fail-soft.
      if (data.source === 'default') {
        void fetch('/api/panel/entitlement/bootstrap', { method: 'POST' }).catch(() => {});
      }
    } catch (error) {
      // Never crash the dashboard — fall back to free.
      console.error('[entitlement] client fetch failed, defaulting to free:', error);
      applyFreeEntitlement();
    } finally {
      setLoading(false);
    }
  }, [activeSubject, applyFreeEntitlement, signedOut]);

  // Initial load.
  useEffect(() => {
    void load();
  }, [load]);

  // Clerk sign-out is session truth. Clear the in-memory plan immediately so a
  // persisted founder badge cannot survive while the teardown request runs.
  useEffect(() => {
    if (signedOut) applyFreeEntitlement();
  }, [applyFreeEntitlement, signedOut]);

  // Re-pull when the entitlement changes underneath us (e.g. after the sign-in
  // sync applies a founder/subscription license) so the UI flips live.
  useEffect(() => {
    const onRefresh = (event: Event) => {
      if (isSignedOutEntitlementRefresh((event as CustomEvent<unknown>).detail)) {
        applyFreeEntitlement();
        return;
      }
      void load();
    };
    window.addEventListener('o8:entitlement-refresh', onRefresh);
    return () => window.removeEventListener('o8:entitlement-refresh', onRefresh);
  }, [applyFreeEntitlement, load]);

  const value = useMemo<EntitlementContextValue>(
    () => ({
      plan,
      flags,
      isPro: plan === 'pro' || plan === 'team',
      isTeam: plan === 'team',
      founder,
      actualPlan,
      actualFounder,
      overrideActive,
      loading,
    }),
    [plan, flags, founder, actualPlan, actualFounder, overrideActive, loading],
  );

  return (
    <EntitlementContext.Provider value={value}>{children}</EntitlementContext.Provider>
  );
}
