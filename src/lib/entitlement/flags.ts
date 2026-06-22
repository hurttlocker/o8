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
 *  - free:    no paid levers (BYO / local / the proxy's free taste-allowance).
 *  - pro:     managed-inference proxy.
 *  - team:    managed-inference proxy + shared team governance.
 *  - founder: managed-inference proxy (included for life, fair-use-capped); NOT
 *             team.shared. Early-access (experimental*) is a deliberate founder
 *             perk wired separately (use-founder-status + the experimental
 *             hooks), not a cost/reach lever, so it isn't here.
 *
 * relay.offNetwork and cloud.runners aren't built yet → false for every plan
 * until those levers ship (then they flip to the paying tiers, founders included).
 */
export function resolveFlags(plan: Plan): EntitlementFlags {
  const proxy = plan === 'pro' || plan === 'team' || plan === 'founder';
  const team = plan === 'team';
  return {
    'proxy.inference': proxy,
    'relay.offNetwork': false,
    'cloud.runners': false,
    'team.shared': team,
  };
}
