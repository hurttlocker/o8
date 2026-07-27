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
import {
  probeCodexVoiceCapability,
  type CodexVoiceCapability,
  type CodexVoiceProbeOptions,
} from '@/lib/codex/appserver-probe';

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

export type CodexRealtimeTransportMode = 'codex-oauth' | 'text' | 'unavailable';

export interface CodexRealtimeTransportAccess {
  mode: CodexRealtimeTransportMode;
  /** The app-server can start the experimental OAuth-backed S2S lifecycle. */
  s2s: boolean;
  /** At least a Codex text session can be opened through the same local server. */
  available: boolean;
  reason: string;
  capability: CodexVoiceCapability;
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

/**
 * Resolve the launch-scoped Codex transport without changing the existing BYOK
 * access ladder above. An installed/reachable app-server remains useful when
 * OAuth realtime is unavailable: API-key auth and experimental-surface drift
 * both fall back to a normal text thread instead of failing the whole session.
 */
export function resolveCodexRealtimeTransportAccessWith(
  capability: CodexVoiceCapability,
): CodexRealtimeTransportAccess {
  if (capability.capable) {
    return {
      mode: 'codex-oauth',
      s2s: true,
      available: true,
      reason: 'Using Connected Voice through the local Codex app-server and ChatGPT OAuth.',
      capability,
    };
  }

  if (
    capability.installation.installed
    && capability.appServer.reachable
    && capability.appServer.transports.includes('stdio')
  ) {
    const reason = capability.auth.mode === 'api_key'
      ? 'Codex is using API-key auth, so Connected Voice is unavailable; using text automatically.'
      : `${capability.whyNot ?? 'Codex realtime is unavailable'} Using text automatically.`;
    return {
      mode: 'text',
      s2s: false,
      available: true,
      reason,
      capability,
    };
  }

  return {
    mode: 'unavailable',
    s2s: false,
    available: false,
    reason: capability.appServer.reachable
      ? 'The local Codex app-server is reachable, but the launch transport requires stdio.'
      : capability.whyNot ?? 'The local Codex app-server is unavailable.',
    capability,
  };
}

export async function resolveCodexRealtimeTransportAccess(
  options: CodexVoiceProbeOptions = {},
): Promise<CodexRealtimeTransportAccess> {
  return resolveCodexRealtimeTransportAccessWith(
    await probeCodexVoiceCapability(options),
  );
}
