/** Shared Node/native credential protocol. See crates/o8-provider-keys. */
import 'server-only';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { decryptValueSync, encryptValueSync } from '@/lib/db/master-key';

export const PROVIDER_ENV_KEYS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'ELEVENLABS_API_KEY', 'GOOGLE_TTS_API_KEY'] as const;
const managedEnv = new Map<string, string>();
const managedName = (name: string) => `O8_KEY_MANAGED_${name}`;
const disabledName = (name: string) => `O8_KEY_DISABLED_${name}`;
function textFile(path: string): string {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
export function parseKeyEnv(raw: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values.set(match[1], match[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  return values;
}
function snapshot() {
  const raw = textFile(join(getDataDir(), '.env.local'));
  return { raw, values: parseKeyEnv(raw) };
}
function decode(raw: string): string {
  if (!raw.startsWith('enc:')) return raw.trim();
  const match = /^enc:([a-fA-F0-9]{24}):((?:[a-fA-F0-9]{2}){16,})$/.exec(raw);
  const plain = match ? decryptValueSync(match[2], match[1]) : null;
  if (plain === null) throw new Error('Credential store unavailable');
  return plain.trim();
}
export function assertProviderStoreAvailable(): void {
  const { values } = snapshot();
  for (const name of PROVIDER_ENV_KEYS) {
    const raw = values.get(name);
    if (raw) decode(raw);
  }
}
export function storedProviderKey(name: string): string | null {
  const raw = snapshot().values.get(name);
  return raw ? decode(raw) || null : null;
}
export function providerKeyEnabled(name: string): boolean {
  const flag = snapshot().values.get(disabledName(name));
  if (flag !== undefined) return flag !== '1';
  if (name === 'OPENROUTER_API_KEY') {
    const raw = textFile(join(getDataDir(), 'providers', 'openrouter.json'));
    return !raw || JSON.parse(raw).enabled !== false;
  }
  return true;
}
export function updateManagedProviderKey(name: string, value: string | null): void {
  managedEnv.set(name, value ?? '');
  if (value) process.env[name] = value;
  else delete process.env[name];
}
/** Fresh on every use. A persisted removal suppresses legacy/ambient resurrection. */
export function clearManagedProviderKey(name: string): void {
  if (managedEnv.has(name) && process.env[name] === managedEnv.get(name)) updateManagedProviderKey(name, null);
}
export function resolveProviderKey(name: string): string | null {
  try {
    const { values } = snapshot();
    if (!providerKeyEnabled(name)) { clearManagedProviderKey(name); return null; }
    const raw = values.get(name);
    if (values.get(managedName(name)) === '1') {
      const value = raw ? decode(raw) || null : null;
      updateManagedProviderKey(name, value);
      return value;
    }
    const ambient = process.env[name]?.trim()
      || (name === 'GEMINI_API_KEY' ? process.env.GOOGLE_AI_API_KEY?.trim() || process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() : undefined);
    if (ambient && ambient !== managedEnv.get(name)) return ambient;
    const value = raw ? decode(raw) || null : null;
    updateManagedProviderKey(name, value);
    return value;
  } catch { clearManagedProviderKey(name); return null; }
}
export function mutateProviderKey(name: string, change: { key?: string | null; enabled?: boolean }): void {
  if (!(PROVIDER_ENV_KEYS as readonly string[]).includes(name)) throw new Error('Unsupported provider key');
  const dir = getDataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // SQLite's OS lock is shared with Rust and released even after process termination.
  const lock = new Database(join(dir, '.provider-keys.lock'), { timeout: 0 });
  let temporary: string | undefined;
  try {
    lock.exec('BEGIN EXCLUSIVE');
    const { raw, values } = snapshot();
    assertProviderStoreAvailable();
    const updates = new Map<string, string | null>();
    for (const provider of PROVIDER_ENV_KEYS) {
      const legacy = values.get(provider);
      if (legacy && !legacy.startsWith('enc:')) {
        const { iv, ciphertext } = encryptValueSync(legacy);
        updates.set(provider, `enc:${iv}:${ciphertext}`);
      }
    }
    if ('key' in change) {
      let encoded: string | null = null;
      if (change.key) {
        const { iv, ciphertext } = encryptValueSync(change.key.trim());
        encoded = `enc:${iv}:${ciphertext}`;
      }
      updates.set(name, encoded);
      updates.set(managedName(name), '1');
    }
    if (change.enabled !== undefined) updates.set(disabledName(name), change.enabled ? '0' : '1');
    const lines = raw.split('\n').filter(line => !updates.has(line.split('=')[0].trim()));
    for (const [key, value] of updates) if (value !== null) lines.push(`${key}=${value}`);
    // Preserve all untouched ciphertext and unrelated lines, including comments.
    temporary = join(dir, `.provider-keys.${randomUUID()}.tmp`);
    writeFileSync(temporary, lines.join('\n'), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, join(dir, '.env.local'));
  } finally {
    if (temporary) { try { unlinkSync(temporary); } catch { /* Already renamed. */ } }
    lock.close();
  }
}
