import type { Plan } from '@/lib/entitlement/types';

/** Display names only. Stored plan identifiers and entitlements stay unchanged. */
export const PLAN_LABELS: Readonly<Record<Plan, string>> = {
  free: 'Free',
  pro: 'Pro',
  team: 'Team',
  founder: 'Pro · Lifetime',
};
