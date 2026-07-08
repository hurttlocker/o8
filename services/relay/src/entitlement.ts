/**
 * Entitlement flag map — the RELAY's copy.
 *
 * ⚠️⚠️⚠️  TWIN-MAP DRIFT HAZARD — THIS IS COPY #3 OF THREE.  ⚠️⚠️⚠️
 * The `relay.offNetwork` predicate is derived independently in THREE places and
 * they MUST agree or off-network relay silently half-works (e.g. the desktop
 * dials out but the relay rejects it, or the phone thinks it's entitled but the
 * Mac never connected):
 *
 *   1. o8 desktop:  src/lib/entitlement/flags.ts        (resolveFlags)
 *   2. o8 mobile:   o8-mobile/src/o8/entitlement.ts     (resolveFlags — mobile lane)
 *   3. o8 relay:    services/relay/src/entitlement.ts   (THIS FILE)
 *
 * v1 accepts three copies of this ~10-line map. The durable fix — the license
 * server embedding the resolved flags directly in the plan-JWT so all three
 * collapse into "read the claim" — is tracked as follow-up (docs/relay-v1-design.md
 * §D1). Until then: change all three in lockstep.
 *
 * Q ruling 2026-07-08: relay.offNetwork = "all paid tiers". Today only 'founder'
 * is a live paid tier ('pro'/$19, 'team'/$29 aren't sold yet), so it reads as
 * founders-only in practice but flips on automatically at their launch. free → false.
 */

export type Plan = 'free' | 'pro' | 'team' | 'founder';

const VALID_PLANS: readonly Plan[] = ['free', 'pro', 'team', 'founder'];

export function isPlan(value: unknown): value is Plan {
  return typeof value === 'string' && (VALID_PLANS as readonly string[]).includes(value);
}

/** True when `plan` is entitled to the off-network relay. Keep in lockstep (see header). */
export function relayOffNetwork(plan: Plan): boolean {
  // "is a paid tier" — pro || team || founder. Mirror of the desktop `proxy` set.
  return plan === 'pro' || plan === 'team' || plan === 'founder';
}
