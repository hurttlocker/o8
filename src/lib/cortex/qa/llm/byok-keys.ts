/**
 * BYOK key resolver for the Cortex Q&A layer (#960).
 *
 * Resolution order for each env var:
 *   1. Stored user key — encrypted in ~/.o8/.env.local (set via Settings > API Keys)
 *   2. process.env — smoke / dev / founder's existing env vars
 *
 * When O8_BYOK_REQUIRED=1, the stored user key MUST be present (tier 3 is
 * hidden from the chain if it's absent). Without the flag the resolution falls
 * back to process.env so smoke and the founder's dev env continue to work
 * unchanged.
 *
 * Stored OpenRouter credentials are refreshed before new sessions so a save or
 * removal in the API process is also seen by the WebSocket process. Explicit
 * ambient credentials retain precedence. No secret is returned by inventory.
 */

import 'server-only';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { isOpenRouterEnabled } from '@/lib/providers/openrouter-connection';

// ── Constants ─────────────────────────────────────────────────────────────────

const ENC_PREFIX = 'enc:' as const;
const CONFIG_DIR = getDataDir();
const ENV_FILE = join(CONFIG_DIR, '.env.local');

// ── Lazy sync parse of ~/.o8/.env.local ──────────────────────────────────────

/**
 * Parse raw env lines (synchronous). Returns a map of key → raw stored value
 * (either `enc:<iv>:<ct>` or legacy plaintext).
 *
 * This read is intentionally fresh. Processes share the encrypted file but not
 * process.env, so process-lifetime caching would retain rotated/deleted keys.
 */
function parseRawEnvFileSync(): Map<string, string> {
  const vars = new Map<string, string>();
  if (!existsSync(ENV_FILE)) return vars;
  try {
    const content = readFileSync(ENV_FILE, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const k = trimmed.slice(0, eqIdx).trim();
      let v = trimmed.slice(eqIdx + 1).trim();
      if (!v.startsWith(ENC_PREFIX)) {
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        ) {
          v = v.slice(1, -1);
        }
      }
      vars.set(k, v);
    }
  } catch {
    // File unreadable — treat as absent.
  }
  return vars;
}

// ── Async decrypt ─────────────────────────────────────────────────────────────

async function decodeStoredValue(stored: string): Promise<string | null> {
  if (!stored.startsWith(ENC_PREFIX)) {
    // Legacy plaintext.
    return stored;
  }
  const rest = stored.slice(ENC_PREFIX.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) return null;
  const iv = rest.slice(0, colonIdx);
  const ct = rest.slice(colonIdx + 1);
  // Lazy import to avoid pulling master-key into non-server bundles.
  const { decryptValue } = await import('@/lib/db/master-key');
  return decryptValue(ct, iv);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve OpenRouter from an explicit ambient key, then encrypted local storage.
 * Values this module injected into process.env are refreshed from storage on
 * every call. A removed stored key is also removed from the child environment.
 */
// Track only values injected by this module/API, so genuine shell credentials
// keep their precedence while sibling processes can refresh a saved credential.
let managedOpenRouterValue: string | undefined;
export function updateManagedOpenRouterKey(value: string | null): void {
  managedOpenRouterValue = value ?? '';
  if (value) process.env.OPENROUTER_API_KEY = value;
  else delete process.env.OPENROUTER_API_KEY;
}
/**
 * Turning the OpenRouter connection off (#3583) stops every o8 caller, whatever
 * the key's source. A value this module injected also leaves process.env so
 * later child processes cannot inherit it; a shell key is left in place.
 */
export async function resolveOpenRouterKey(): Promise<string | null> {
  if (!isOpenRouterEnabled()) {
    if (managedOpenRouterValue && process.env.OPENROUTER_API_KEY === managedOpenRouterValue) updateManagedOpenRouterKey(null);
    return null;
  }
  const envKey = process.env.OPENROUTER_API_KEY?.trim() ?? '';
  if (envKey && envKey !== managedOpenRouterValue) return envKey;
  const raw = parseRawEnvFileSync().get('OPENROUTER_API_KEY');
  const plain = raw ? (await decodeStoredValue(raw))?.trim() || null : null;
  updateManagedOpenRouterKey(plain);
  return plain;
}

/**
 * Resolve the OpenAI API key — the BYOK key for Symon Realtime mode
 * (gpt-realtime). Same env-first → encrypted ~/.o8/.env.local precedence as
 * resolveOpenRouterKey: the /api/v2/keys POST route sets process.env on save,
 * so env wins; on a cold start we fall through to the encrypted file. Returns
 * null when neither source has a value (→ the Realtime access resolver treats
 * the user as having no BYOK key).
 */
export async function resolveOpenAIKey(): Promise<string | null> {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) return envKey;

  const raw = parseRawEnvFileSync().get('OPENAI_API_KEY');
  if (!raw) return null;
  const plain = await decodeStoredValue(raw);
  if (plain?.trim()) {
    process.env.OPENAI_API_KEY = plain.trim();
    return plain.trim();
  }
  return null;
}

/**
 * Returns true when O8_BYOK_REQUIRED=1 AND no stored OpenRouter key exists.
 * When true, tier 3 (OpenRouter) should be skipped in the compose chain.
 */
export async function isByokRequired(): Promise<boolean> {
  if (process.env.O8_BYOK_REQUIRED !== '1') return false;
  const key = await resolveOpenRouterKey();
  return !key;
}
