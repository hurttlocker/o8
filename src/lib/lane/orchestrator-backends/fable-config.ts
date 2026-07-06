/**
 * Fable orchestrator config resolution (mirrors `collide-config.ts`).
 *
 * The Fable backend forces the `claude-fable-5` model and injects the operator's
 * BYO Anthropic key into ONLY the Fable proc's spawn env — never the ambient
 * subscription procs, which would re-bill them. Resolution reads env each call
 * so an override applies on the next turn.
 *
 * This module is a pure LEAF (no heavy imports), so BOTH the backend (`fable.ts`)
 * and the spawn-side lockout (`../fable-profile.ts`) can import it without an
 * import cycle through `orchestrator-session.ts`.
 */

import { MODEL_IDS } from '@/lib/models';

/** Default Fable model; env override `O8_FABLE_MODEL`. */
export const DEFAULT_FABLE_MODEL = MODEL_IDS.fableDefault;

/**
 * Env var holding the operator's BYO Anthropic API key for Fable turns. Kept
 * SEPARATE from the ambient `ANTHROPIC_API_KEY` on purpose: the subscription
 * orchestrator procs spread `process.env`, so a bare `ANTHROPIC_API_KEY` would
 * leak API-billing into them. This var is mapped onto `ANTHROPIC_API_KEY` for the
 * Fable proc ONLY (see `fableEnvOverride` in `../fable-profile.ts`).
 */
export const FABLE_API_KEY_ENV = 'O8_FABLE_ANTHROPIC_API_KEY';

export interface FableConfig {
  /** Model forced onto the turn (applied AFTER the `...options` spread). */
  model: string;
  /** Operator's BYO key, or null when unset (turn then runs on ambient creds). */
  apiKey: string | null;
}

/** Resolve the active Fable config from env (re-read each call). */
export function resolveFableConfig(): FableConfig {
  const model = process.env.O8_FABLE_MODEL?.trim() || DEFAULT_FABLE_MODEL;
  const rawKey = process.env[FABLE_API_KEY_ENV]?.trim();
  return { model, apiKey: rawKey || null };
}

/** BYO key alone — used by the spawn-side env injection. */
export function resolveFableApiKey(): string | null {
  return resolveFableConfig().apiKey;
}
