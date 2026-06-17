'use client';

/**
 * EntitlementProvider — client-side entitlement state.
 *
 * Fetches GET /api/panel/entitlement once on mount and exposes the resolved
 * plan + flags to the dashboard tree. Modeled on src/lib/theme/context.tsx
 * (createContext + provider + hook). The /api/panel/* route is loopback-gated
 * in src/middleware.ts; the Tauri webview runs same-origin so a plain relative
 * fetch passes the gate — no auth header to add (matches every other
 * /api/panel/* client caller, e.g. UpdateCard / ApprovalBanner).
 *
 * Defaults to free + loading=true until the fetch resolves, and falls back to
 * free if the fetch fails (never crashes the dashboard). No feature is gated
 * here — this is the rendering layer only (M2).
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
} from 'react';

import { resolveFlags } from './flags';
import type { EntitlementFlags, Plan } from './types';

interface EntitlementContextValue {
  plan: Plan;
  flags: EntitlementFlags;
  isPro: boolean;
  isTeam: boolean;
  loading: boolean;
}

const FREE_FLAGS = resolveFlags('free');

const EntitlementContext = createContext<EntitlementContextValue>({
  plan: 'free',
  flags: FREE_FLAGS,
  isPro: false,
  isTeam: false,
  loading: true,
});

export function useEntitlement() {
  return useContext(EntitlementContext);
}

interface EntitlementResponse {
  plan?: unknown;
  flags?: unknown;
  source?: unknown;
}

function coercePlan(value: unknown): Plan {
  return value === 'pro' || value === 'team' ? value : 'free';
}

export function EntitlementProvider({ children }: { children: React.ReactNode }) {
  const [plan, setPlan] = useState<Plan>('free');
  const [flags, setFlags] = useState<EntitlementFlags>(FREE_FLAGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch('/api/panel/entitlement', { cache: 'no-store' });
        if (!res.ok) throw new Error(`entitlement fetch failed: ${res.status}`);
        const data = (await res.json()) as EntitlementResponse;
        if (cancelled) return;
        const nextPlan = coercePlan(data.plan);
        setPlan(nextPlan);
        // Re-derive flags from the plan so the client always agrees with the
        // single source of truth (flags.ts), even if the payload is partial.
        setFlags(resolveFlags(nextPlan));
        // First-run: no token yet (source 'default') → issue a free account
        // token in the background so this install has a stable `sub` for usage
        // attribution + can reach the managed proxy. Idempotent + fail-soft;
        // the plan stays free, so there's nothing to re-render on success.
        if (data.source === 'default') {
          void fetch('/api/panel/entitlement/bootstrap', { method: 'POST' }).catch(() => {});
        }
      } catch (error) {
        // Never crash the dashboard — fall back to free.
        console.error('[entitlement] client fetch failed, defaulting to free:', error);
        if (cancelled) return;
        setPlan('free');
        setFlags(FREE_FLAGS);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<EntitlementContextValue>(
    () => ({
      plan,
      flags,
      isPro: plan === 'pro' || plan === 'team',
      isTeam: plan === 'team',
      loading,
    }),
    [plan, flags, loading],
  );

  return (
    <EntitlementContext.Provider value={value}>{children}</EntitlementContext.Provider>
  );
}
