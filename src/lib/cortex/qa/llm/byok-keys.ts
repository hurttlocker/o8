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
 * IMPORTANT: this module runs server-side only. It reads ~/.o8/.env.local
 * synchronously (one stat + one read per cold call) and caches for the process
 * lifetime. The cache is busted whenever the POST /api/v2/keys route updates
 * process.env directly (which is the existing behaviour after a save).
 */

import 'server-only';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

// ── Constants ─────────────────────────────────────────────────────────────────

const ENC_PREFIX = 'enc:' as const;
const CONFIG_DIR = getDataDir();
const ENV_FILE = join(CONFIG_DIR, '.env.local');

// ── Lazy sync parse of ~/.o8/.env.local ──────────────────────────────────────

/**
 * Parse raw env lines (synchronous). Returns a map of key → raw stored value
 * (either `enc:<iv>:<ct>` or legacy plaintext).
 *
 * We read the file fresh on each process startup (no persistent module-level
 * cache) because process.env is updated by the /api/v2/keys POST route
 * immediately after a save, so process.env is always the freshest source for
 * the current process. The file read is the cold-start path only.
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
 * Resolve the OpenRouter API key for the Cortex Q&A tier.
 *
 * Resolution order:
 *   1. process.env.OPENROUTER_API_KEY — already set (smoke / dev / prior save)
 *   2. Stored encrypted value in ~/.o8/.env.local (cold start after reboot)
 *
 * Returns null when neither source has a value.
 *
 * NOTE: process.env is checked FIRST because the /api/v2/keys POST route
 * sets process.env immediately after a successful save. On a cold process
 * start before any save the env var is absent, so we fall through to the
 * file. This means the smoke path (OPENROUTER_API_KEY in the shell env)
 * always wins — no regression for smoke or the founder's dev env.
 */
export async function resolveOpenRouterKey(): Promise<string | null> {
  // 1. process.env — smoke / dev / prior save in same process
  const envKey = process.env.OPENROUTER_API_KEY?.trim();
  if (envKey) return envKey;

  // 2. ~/.o8/.env.local (cold start)
  const raw = parseRawEnvFileSync().get('OPENROUTER_API_KEY');
  if (!raw) return null;
  const plain = await decodeStoredValue(raw);
  if (plain?.trim()) {
    // Warm process.env so subsequent calls in this request skip the file read.
    process.env.OPENROUTER_API_KEY = plain.trim();
    return plain.trim();
  }
  return null;
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
