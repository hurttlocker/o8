/** Retryable plaintext cleanup after the shared store becomes authoritative. */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getDataDir } from '@/lib/data-dir-migration';

const LEGACY_PREFS = {
  gemini_api_key: 'GEMINI_API_KEY', openrouter_api_key: 'OPENROUTER_API_KEY',
  groq_api_key: 'GROQ_API_KEY', elevenlabs_api_key: 'ELEVENLABS_API_KEY', google_tts_api_key: 'GOOGLE_TTS_API_KEY',
};

/** Managed markers are durable cleanup receipts, including removal tombstones. */
export function cleanupLegacyProviderKeys(values: ReadonlyMap<string, string>): void {
  const dir = getDataDir();
  const path = join(dir, 'dictation.json');
  if (!existsSync(path) || !Object.values(LEGACY_PREFS).some(name => values.get(`O8_KEY_MANAGED_${name}`) === '1')) return;
  let lock: Database.Database | undefined;
  let temporary: string | undefined;
  try {
    lock = new Database(join(dir, '.voice-prefs.lock'), { timeout: 0 });
    lock.exec('BEGIN EXCLUSIVE');
    const prefs: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) throw new Error('Voice preferences unavailable');
    const obj = prefs as Record<string, unknown>;
    let changed = false;
    for (const [pref, name] of Object.entries(LEGACY_PREFS)) {
      if (values.get(`O8_KEY_MANAGED_${name}`) === '1' && Object.hasOwn(obj, pref)) { delete obj[pref]; changed = true; }
    }
    if (!changed) return;
    temporary = join(dir, `.voice-prefs.${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(obj, null, 2), { mode: 0o600, flag: 'wx' });
    const fd = openSync(temporary, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } catch { console.warn('[keys] Credential state preserved; legacy preference cleanup pending'); }
  finally {
    if (temporary) { try { unlinkSync(temporary); } catch { /* Already renamed. */ } }
    lock?.close();
  }
}
