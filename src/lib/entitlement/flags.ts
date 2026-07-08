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
 * relay.offNetwork SHIPPED 2026-07-08 (o8 Relay v1, docs/relay-v1-design.md). Q
 * ruling: entitlement is "all paid tiers" in principle; today only 'founder' is a
 * live paid tier (the $19 'pro'/$29 'team' tiers aren't sold yet), so it reads as
 * founders-only in practice but flips on automatically the moment pro/team launch
 * ("future paid → true at launch", zero code change). free → false.
 *
 *   ⚠️ TWIN-MAP DRIFT HAZARD — this flag is derived in THREE places that MUST agree
 *   or off-network silently half-works:
 *     1. src/lib/entitlement/flags.ts          (this file — desktop)
 *     2. o8-mobile/src/o8/entitlement.ts       (mobile client — mobile agent flips)
 *     3. services/relay/src/entitlement.ts     (the relay's own copy)
 *   The durable fix (license server embeds flags in the JWT so all three collapse)
 *   is tracked as follow-up. Until then, change all three in lockstep.
 *
 * cloud.runners isn't built yet → false for every plan until that lever ships.
 */
export function resolveFlags(plan: Plan): EntitlementFlags {
  const proxy = plan === 'pro' || plan === 'team' || plan === 'founder';
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
