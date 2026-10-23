/** Legacy service authorization types. The app has one free edition.
 * Retained for funded inference, voice, relay admission, and token consumers
 * until their replacement paths are ready. Never use these for local UI access.
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
  /**
   * The delegated live voice brain for Symon — a metered voice layer billed per
   * minute on top of its backend model's tokens. A cost lever, not a capability:
   * every plan keeps the standard realtime brain.
   */
  'voice.liveBrain': boolean;
}

export type EntitlementSource = 'env' | 'file' | 'default';

export interface EntitlementState {
  /** Effective legacy service class after any existing suppression. */
  plan: Plan;
  /** Legacy service flags, never local UI access. */
  flags: EntitlementFlags;
  source: EntitlementSource;
  /** Resolved service class before existing suppression. */
  actualPlan: Plan;
  /** Existing read-only suppression is active. Retained for funded callers. */
  overrideActive: boolean;
}

/** Legacy account metadata retained for service-license sync and cleanup.
 * The application does not render edition badges or account serials.
 */
export interface FounderInfo {
  operatorNumber: number;
  /** Legacy metadata retained for compatibility. */
  tier: number | null;
}
