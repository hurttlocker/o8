export const dynamic = 'force-dynamic';

/**
 * API Key Management (BYOK — Bring Your Own Key)
 *
 * GET  /api/v2/keys — list configured providers (keys masked)
 * POST /api/v2/keys — set/update a provider key
 * DELETE /api/v2/keys — remove a provider key
 *
 * Keys are AES-256-GCM encrypted at rest inside ~/.o8/.env.local.
 * The encryption master key lives in the macOS Keychain (Tauri builds) or
 * the O8_MASTER_KEY env var (dev / non-macOS). Plaintext values written by
 * older installs are migrated to encrypted form on first read.
 *
 * Storage format (per line in .env.local):
 *   PROVIDER_KEY=enc:<hex-iv>:<hex-ciphertext+authtag>
 *
 * Legacy plaintext lines are re-encrypted automatically on next write.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { requirePanelAuth } from '@/lib/panel/auth';
import { encryptValue, decryptValue } from '@/lib/db/master-key';
import { getDataDir } from '@/lib/data-dir-migration';

// Prefix that distinguishes an encrypted value from legacy plaintext.
const ENC_PREFIX = 'enc:' as const;

// Config lives in ~/.o8/ so it survives app updates
const CONFIG_DIR = getDataDir();
const ENV_FILE = join(CONFIG_DIR, '.env.local');

// Also check project-local .env.local as fallback (dev mode)
const LOCAL_ENV = join(process.cwd(), '.env.local');

interface ProviderKeyConfig {
  id: string;
  label: string;
  envVar: string;
  placeholder: string;
  docsUrl: string;
  validateUrl?: string;
}

// BYOK (#960): OpenRouter + Anthropic are the two user-managed keys for beta.
// CLI runtimes (codex, claude-code, gemini, opencode) handle their own auth.
// Kill these before official release in favour of the hosted subscription tier.
const PROVIDERS: ProviderKeyConfig[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    envVar: 'OPENROUTER_API_KEY',
    placeholder: 'sk-or-...',
    docsUrl: 'https://openrouter.ai/keys',
    validateUrl: 'https://openrouter.ai/api/v1/models',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    envVar: 'DEEPSEEK_API_KEY',
    placeholder: 'sk-...',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    validateUrl: 'https://api.deepseek.com/models',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    placeholder: 'sk-ant-...',
    docsUrl: 'https://console.anthropic.com/keys',
    validateUrl: 'https://api.anthropic.com/v1/messages',
  },
  {
    // BYOK for Symon Realtime mode (gpt-realtime). Free path — the user's key
    // bills OpenAI directly, o8 never spends (the managed/proxied path is the
    // paid lever). See src/lib/voice/realtime-access.ts.
    id: 'openai',
    label: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    placeholder: 'sk-...',
    docsUrl: 'https://platform.openai.com/api-keys',
    validateUrl: 'https://api.openai.com/v1/models',
  },
];

/**
 * Parse raw env lines from a file. Returns a map of key → raw stored value
 * (which may be an `enc:…` blob or legacy plaintext).
 */
function parseRawEnvFromPath(filePath: string): Map<string, string> {
  const vars = new Map<string, string>();
  if (!existsSync(filePath)) return vars;
  const content = readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const k = trimmed.slice(0, eqIdx).trim();
    let v = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes from legacy plaintext values only.
    if (!v.startsWith(ENC_PREFIX)) {
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
    }
    vars.set(k, v);
  }
  return vars;
}

/**
 * Decode a stored value: decrypt `enc:iv:ct` blobs, pass plaintext through as-is.
 * Returns null if decryption fails (corrupt / wrong key).
 */
async function decodeStoredValue(stored: string): Promise<string | null> {
  if (!stored.startsWith(ENC_PREFIX)) {
    // Legacy plaintext — return unchanged.
    return stored;
  }
  // Format: enc:<hex-iv>:<hex-ciphertext+authtag>
  const rest = stored.slice(ENC_PREFIX.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) return null;
  const iv = rest.slice(0, colonIdx);
  const ct = rest.slice(colonIdx + 1);
  return decryptValue(ct, iv);
}

/**
 * Encode a plaintext value to the `enc:iv:ct` storage format.
 */
async function encodeStoredValue(plaintext: string): Promise<string> {
  const { ciphertext, iv } = await encryptValue(plaintext);
  return `${ENC_PREFIX}${iv}:${ciphertext}`;
}

/**
 * Read all provider env vars from the config files, decrypting enc: blobs.
 * Returns a map of envVar → plaintext value (or empty string if missing).
 */
async function parseEnvFile(): Promise<Map<string, string>> {
  const rawLocal = parseRawEnvFromPath(LOCAL_ENV);
  const rawGlobal = parseRawEnvFromPath(ENV_FILE);
  const merged = new Map([...rawLocal, ...rawGlobal]);

  const decoded = new Map<string, string>();
  for (const [k, v] of merged) {
    const plain = await decodeStoredValue(v);
    if (plain !== null) {
      decoded.set(k, plain);
    } else {
      // decodeStoredValue only returns null for enc: blobs that failed GCM
      // auth — wrong master key or corrupt blob. Dropping silently makes
      // stored keys "vanish" with zero diagnostics.
      console.warn(`[keys] failed to decrypt ${k} — wrong master key or corrupt blob; skipping`);
    }
  }
  return decoded;
}

/**
 * Write provider env vars to ~/.o8/.env.local, encrypting each value.
 * Non-provider lines (comments, unrecognised keys) are preserved verbatim.
 */
async function writeEnvFile(vars: Map<string, string>): Promise<void> {
  mkdirSync(CONFIG_DIR, { recursive: true });

  let lines: string[] = [];
  if (existsSync(ENV_FILE)) {
    lines = readFileSync(ENV_FILE, 'utf-8').split('\n');
  }

  const written = new Set<string>();

  // Build updated line list. For keys we're writing, replace with encrypted form.
  const updated: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      updated.push(line);
      continue;
    }
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) {
      updated.push(line);
      continue;
    }
    const k = trimmed.slice(0, eqIdx).trim();
    if (vars.has(k)) {
      written.add(k);
      const encoded = await encodeStoredValue(vars.get(k)!);
      updated.push(`${k}=${encoded}`);
    } else {
      updated.push(line);
    }
  }

  // Append any new keys not already in the file.
  for (const [k, v] of vars) {
    if (!written.has(k)) {
      const encoded = await encodeStoredValue(v);
      updated.push(`${k}=${encoded}`);
    }
  }

  writeFileSync(ENV_FILE, updated.join('\n'));
}

async function validateKey(config: ProviderKeyConfig, key: string): Promise<{ valid: boolean; error?: string }> {
  if (!config.validateUrl) return { valid: true };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const headers: Record<string, string> = {};

    if (config.id === 'anthropic') {
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
      headers['content-type'] = 'application/json';
      // Anthropic requires a POST to /messages — use a minimal request that will 400 but proves auth works
      const res = await fetch(config.validateUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      // 200 or 400 (bad request) means the key authenticated — only 401/403 means invalid
      if (res.status === 401 || res.status === 403) return { valid: false, error: 'Invalid API key' };
      return { valid: true };
    }

    if (config.id === 'google') {
      const res = await fetch(config.validateUrl, {
        headers: { 'x-goog-api-key': key },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.status === 400 || res.status === 401 || res.status === 403) return { valid: false, error: 'Invalid API key' };
      return { valid: true };
    }

    if (config.id === 'github') {
      headers['Authorization'] = `token ${key}`;
    } else {
      headers['Authorization'] = `Bearer ${key}`;
    }

    const res = await fetch(config.validateUrl, { headers, signal: controller.signal });
    clearTimeout(timeout);
    if (res.status === 401 || res.status === 403) return { valid: false, error: 'Invalid API key' };
    return { valid: true };
  } catch {
    // Network error — don't block saving, just warn
    return { valid: true, error: 'Could not validate (network error) — key saved anyway' };
  }
}

function maskKey(key: string): string {
  if (key.length <= 8) return '••••••••';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

// GET — list providers with masked keys
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const envVars = await parseEnvFile();
  // Also check process.env (may be set outside .env.local)
  const providers = PROVIDERS.map((p) => {
    const envValue = envVars.get(p.envVar) || process.env[p.envVar] || '';
    return {
      id: p.id,
      label: p.label,
      envVar: p.envVar,
      placeholder: p.placeholder,
      docsUrl: p.docsUrl,
      configured: !!envValue,
      maskedKey: envValue ? maskKey(envValue) : null,
    };
  });

  return NextResponse.json({ providers });
}

// POST — set/update a key
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => null);
  if (!body?.provider || !body?.key) {
    return NextResponse.json({ error: 'provider and key are required' }, { status: 400 });
  }

  const config = PROVIDERS.find((p) => p.id === body.provider);
  if (!config) {
    return NextResponse.json({ error: `Unknown provider: ${body.provider}` }, { status: 400 });
  }

  const key = body.key.trim();
  if (!key) {
    return NextResponse.json({ error: 'Key cannot be empty' }, { status: 400 });
  }

  // Validate key against provider API before saving
  const validation = await validateKey(config, key);
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error || 'Invalid API key' }, { status: 400 });
  }

  // Read existing plaintext map (decrypted), update, then re-encrypt all entries.
  const envVars = await parseEnvFile();
  envVars.set(config.envVar, key);
  await writeEnvFile(envVars);

  // Also set in process.env so it takes effect immediately (no restart needed)
  process.env[config.envVar] = key;

  return NextResponse.json({
    success: true,
    provider: config.id,
    maskedKey: maskKey(key),
    warning: validation.error || undefined,
  });
}

// DELETE — remove a key
export async function DELETE(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => null);
  if (!body?.provider) {
    return NextResponse.json({ error: 'provider is required' }, { status: 400 });
  }

  const config = PROVIDERS.find((p) => p.id === body.provider);
  if (!config) {
    return NextResponse.json({ error: `Unknown provider: ${body.provider}` }, { status: 400 });
  }

  // Remove from .env.local (delete key, re-encrypt remaining entries).
  const envVars = await parseEnvFile();
  envVars.delete(config.envVar);
  await writeEnvFile(envVars);

  // Clear from process.env
  delete process.env[config.envVar];

  return NextResponse.json({ success: true, provider: config.id });
}
