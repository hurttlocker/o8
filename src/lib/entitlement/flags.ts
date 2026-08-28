import type { EntitlementFlags, Plan } from './types';

/** Pro, Team, and Founder are the paid tiers. Keep paid-feature checks on this
 * predicate so a new caller cannot accidentally treat "signed in" as paid. */
export function isPaidPlan(plan: Plan): boolean {
  return plan === 'pro' || plan === 'team' || plan === 'founder';
}

/**
 * The SINGLE source of truth for the per-plan cost/reach levers.
 *
 * Pure function, no I/O. NOTE: these are NOT feature gates. Every moat —
 * governance, the Engineering Brain, multi-repo fleet, mobile-on-LAN, local
 * voice — is FREE and ungated by the public entitlement contract, so it isn't
 * here. This only maps a Plan to the paid cost/reach levers; real access is
 * additionally enforced at call time by the account token + the server-side
 * spend cap, never by a flag alone.
 *
 *  - free:    no paid levers (BYO / local / the proxy's free taste-allowance).
 *  - pro:     managed-inference proxy.
 *  - team:    managed-inference proxy + shared team governance.
 *  - founder: managed-inference proxy (included for life, fair-use-capped); NOT
 *             team.shared. Early-access (experimental*) is a deliberate founder
 *             perk wired separately (use-founder-status + the experimental
 *             hooks), not a cost/reach lever, so it isn't here.
 *
 * relay.offNetwork follows the public relay contract in docs/internals/connect-contract.md.
 * Entitlement is "all paid tiers" in principle; today only 'founder' is a live
 * paid tier (the $19 'pro'/$29 'team' tiers aren't sold yet), so it reads as
 * founders-only in practice but flips on automatically the moment pro/team launch
 * ("future paid → true at launch", zero code change). free → false.
 *
 *   ⚠️ PROTOCOL DRIFT HAZARD — `relay.offNetwork` is part of the versioned
 *   entitlement contract consumed by the desktop, mobile client, and hosted
 *   relay. All three must resolve the same plan-to-flag mapping or off-network
 *   silently half-works. Until signed tokens carry the resolved flags, any
 *   contract version that changes this mapping must update every consumer in
 *   lockstep.
 *
 * cloud.runners isn't built yet → false for every plan until that lever ships.
 */
export function resolveFlags(plan: Plan): EntitlementFlags {
  const proxy = isPaidPlan(plan);
  const team = plan === 'team';
  return {
    'proxy.inference': proxy,
    // All paid tiers get off-network relay (see twin-map note above). `proxy` is
    // the exact "is a paid tier" predicate, so relay tracks it 1:1.
    'relay.offNetwork': proxy,
    'cloud.runners': false,
    'team.shared': team,
  };
}
