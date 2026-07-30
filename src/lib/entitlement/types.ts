/**
 * Entitlement types — the open-core Free/Pro/Team tier model.
 *
 * This module is the type substrate for the entitlement layer. It is pure
 * (no I/O, not server-only) so both server code (store.ts) and the future
 * client provider can import it.
 */

export type Plan = 'free' | 'pro' | 'team' | 'founder';

/**
 * Cost/reach entitlement levers — NOT feature gates.
 *
 * The model is "monetize cost, not capability": every moat —
 * governance, the Engineering Brain, multi-repo fleet, mobile-on-LAN, local
 * voice — is FREE and ungated, so it is intentionally NOT represented here.
 * These flags track only the paid cost/reach levers. Access is additionally
 * enforced at call time (account token + server-side spend cap), never by a
 * flag alone. `resolveFlags()` (flags.ts) is the single place that derives
 * these from a Plan — never branch on `plan` directly elsewhere.
 */
export interface EntitlementFlags {
  /** Managed-inference proxy — hosted, metered model access (o8 Brain + Symon). Live. */
  'proxy.inference': boolean;
  /** Off-network mobile relay — reach the Mac outside the LAN. Not built yet. */
  'relay.offNetwork': boolean;
  /** Cloud agents — run while the laptop is closed. Not built yet. */
  'cloud.runners': boolean;
  /** Shared team governance (team plan only). */
  'team.shared': boolean;
}

export type EntitlementSource = 'env' | 'file' | 'default';

export interface EntitlementState {
  /** EFFECTIVE plan — the real plan after the dev "view-as" min-clamp (#1517). */
  plan: Plan;
  /** Flags derived from the EFFECTIVE plan. */
  flags: EntitlementFlags;
  source: EntitlementSource;
  /** Real resolved plan BEFORE the view-as clamp. Equals `plan` when no override. */
  actualPlan: Plan;
  /** True when a `~/.o8/dev-plan-override` view-as switch is active. */
  overrideActive: boolean;
}

/**
 * Founding Operator display metadata. Client-safe (pure, no I/O) so both the
 * server founder record (founder.ts) and the client context (context.tsx) share
 * one shape. Cosmetic — the entitlement is the signed `plan: 'founder'`; this
 * only carries the "Founding Operator #N" badge + pricing tier.
 */
export interface FounderInfo {
  operatorNumber: number;
  /** Pricing tier (1=$150, 2=$250, 3=$500), from the assigned operator number. */
  tier: number | null;
}
