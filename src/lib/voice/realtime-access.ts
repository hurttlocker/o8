import 'server-only';

/**
 * Realtime voice (Symon S2S) access resolution — Track B gating (2026-06-19).
 *
 * Encodes o8's "monetize cost, not capability" model (src/lib/entitlement,
 * docs/monetization-and-free-tier-plan.md) for the realtime voice-to-voice
 * agent. Realtime is NOT a capability paywall — it resolves to one of three
 * paths:
 *
 *   - 'byok'    — the user brought their own OpenAI key. FREE for everyone
 *                 ("the devs of the world"); they pay OpenAI directly, o8 never
 *                 spends, so there is no gate. This is the path that works first.
 *   - 'managed' — no BYOK key, but the account carries the paid `proxy.inference`
 *                 lever (pro/team). o8 proxies the realtime session and meters it
 *                 — the "super-paid" path. The proxy itself is a separate build
 *                 (MANAGED_REALTIME_READY); until then the session route returns a
 *                 clear "coming" response for this mode.
 *   - 'locked'  — neither a BYOK key nor the paid lever. The user adds an OpenAI
 *                 key (free) or upgrades (managed). Capability isn't withheld —
 *                 only the COST path is, exactly per the entitlement model.
 *
 * Mirrors the brain-access resolver shape: a pure core (explicit inputs, for
 * tests) + a thin server entry that reads the live entitlement flags. Never
 * branches on `plan` directly — it keys off `proxy.inference`, the single
 * resolveFlags() lever (per the entitlement types contract).
 */

import { getEntitlement } from '@/lib/entitlement/store';

export type RealtimeMode = 'byok' | 'managed' | 'locked';

export interface RealtimeAccess {
  /** Which path this user resolves to. */
  mode: RealtimeMode;
  /** True when a realtime session can be started at all (byok or managed). */
  available: boolean;
  /** Human-readable reason — surfaced in the Founder tab + the session route. */
  reason: string;
}

export interface RealtimeAccessInput {
  /** A usable OpenAI key is resolvable (env or the encrypted ~/.o8/.env.local store). */
  hasByokKey: boolean;
  /** The account's `proxy.inference` entitlement lever (pro/team). */
  proxyInference: boolean;
}

/**
 * Whether the managed (proxied) realtime path is actually wired yet. The paid
 * lever can resolve before the proxy exists; flip to true when the managed
 * realtime proxy ships so the session route stops returning "coming".
 */
export const MANAGED_REALTIME_READY = false;

/** Pure core — exported for tests; pass the inputs explicitly. */
export function resolveRealtimeAccessWith(input: RealtimeAccessInput): RealtimeAccess {
  if (input.hasByokKey) {
    return { mode: 'byok', available: true, reason: 'Using your OpenAI key — billed to you, not o8.' };
  }
  if (input.proxyInference) {
    return MANAGED_REALTIME_READY
      ? { mode: 'managed', available: true, reason: 'Managed realtime — metered through o8.' }
      : { mode: 'managed', available: false, reason: 'Managed realtime is coming — add your own OpenAI key to use it today.' };
  }
  return {
    mode: 'locked',
    available: false,
    reason: 'Add your own OpenAI key (free), or upgrade for managed realtime.',
  };
}

/**
 * Server entry — reads the live entitlement flags, takes whether a BYOK OpenAI
 * key resolved (the caller does the key lookup so this module stays free of the
 * key-store coupling), and resolves the path.
 */
export async function resolveRealtimeAccess(hasByokKey: boolean): Promise<RealtimeAccess> {
  const { flags } = await getEntitlement();
  return resolveRealtimeAccessWith({ hasByokKey, proxyInference: flags['proxy.inference'] });
}
