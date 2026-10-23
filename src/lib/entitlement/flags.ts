import type { EntitlementFlags, Plan } from './types';

/** Legacy funded-service eligibility. Sign-in alone never grants access. */
export function isPaidPlan(plan: Plan): boolean {
  return plan === 'pro' || plan === 'team' || plan === 'founder';
}

/** Compatibility mapping for funded services and relay admission.
 * These values must stay aligned with existing signed-token consumers until
 * the funded-service and connect migrations replace them. No local UI gate
 * reads this mapping. Unimplemented cloud runners remain disabled.
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
    // The live brain bills per voice minute plus the backend model's tokens, so
    // it tracks the paid predicate exactly like the other metered levers.
    'voice.liveBrain': proxy,
  };
}
