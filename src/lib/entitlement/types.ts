/**
 * Entitlement types — the open-core Free/Pro/Team tier model.
 *
 * This module is the type substrate for the entitlement layer. It is pure
 * (no I/O, not server-only) so both server code (store.ts) and the future
 * client provider can import it.
 */

export type Plan = 'free' | 'pro' | 'team';

/**
 * The Pro/Team feature flags. Each key maps to a moat surface that the free
 * tier does not unlock. `resolveFlags()` (flags.ts) is the single place that
 * derives these from a Plan — never branch on `plan` directly elsewhere.
 */
export interface EntitlementFlags {
  'governance.secondPass': boolean;
  'memory.brain': boolean;
  'fleet.multiRepo': boolean;
  'mobile.control': boolean;
  'team.shared': boolean;
}

export type EntitlementSource = 'env' | 'file' | 'default';

export interface EntitlementState {
  plan: Plan;
  flags: EntitlementFlags;
  source: EntitlementSource;
}
