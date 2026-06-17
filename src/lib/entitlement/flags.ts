import type { EntitlementFlags, Plan } from './types';

/**
 * The SINGLE source of truth for the per-plan cost/reach levers.
 *
 * Pure function, no I/O. NOTE: these are NOT feature gates. Every moat —
 * governance, the Engineering Brain, multi-repo fleet, mobile-on-LAN, local
 * voice — is FREE and ungated (docs/monetization-and-free-tier-plan.md §1, §6,
 * §11), so it isn't here. This only maps a Plan to the paid cost/reach levers;
 * real access is additionally enforced at call time by the account token + the
 * server-side spend cap, never by a flag alone.
 *
 *  - free: no paid levers (BYO / local / the proxy's free taste-allowance).
 *  - pro:  managed-inference proxy.
 *  - team: managed-inference proxy + shared team governance.
 *
 * relay.offNetwork and cloud.runners aren't built yet → false for every plan
 * until those levers ship (then they flip to the paying tiers).
 */
export function resolveFlags(plan: Plan): EntitlementFlags {
  const paid = plan === 'pro' || plan === 'team';
  const team = plan === 'team';
  return {
    'proxy.inference': paid,
    'relay.offNetwork': false,
    'cloud.runners': false,
    'team.shared': team,
  };
}
