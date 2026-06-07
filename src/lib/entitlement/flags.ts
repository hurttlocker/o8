import type { EntitlementFlags, Plan } from './types';

/**
 * The SINGLE source of truth for the Free / Pro / Team tier matrix.
 *
 * Pure function, no I/O. Every entitlement decision in the app derives from
 * here — gating code should check a resolved flag, never branch on `plan`.
 *
 *  - free: all moats locked.
 *  - pro:  governance second-pass, Engineering Brain, multi-repo fleet, and
 *          mobile operator control unlocked; team sharing stays locked.
 *  - team: everything pro unlocks, plus shared/team governance.
 */
export function resolveFlags(plan: Plan): EntitlementFlags {
  const pro = plan === 'pro' || plan === 'team';
  const team = plan === 'team';
  return {
    'governance.secondPass': pro,
    'memory.brain': pro,
    'fleet.multiRepo': pro,
    'mobile.control': pro,
    'team.shared': team,
  };
}
