import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ invalidateRuntimeAuthCache: vi.fn() }));
state.dir = mkdtempSync(join(tmpdir(), 'o8-native-key-route-'));
const { clearMasterKeyCache } = await import('@/lib/db/master-key');
const { resolveProviderKey } = await import('@/lib/providers/key-store');
const routes = await import('./route');
const { resolveApiKey } = await import('@/app/api/v2/proxy/llm/provider-config');
const master = Buffer.alloc(32, 37).toString('base64url');
const request = (method: string, body?: unknown) => new NextRequest('http://localhost/api/v2/keys', {
  method, headers: { host: 'localhost' }, ...(body ? { body: JSON.stringify(body) } : {}),
});
const nativeBin = resolve('tests/provider-keys/target/debug/o8-provider-key-tests');
function native(command: object, key = master) {
  return JSON.parse(execFileSync(nativeBin, [], {
    input: JSON.stringify(command), encoding: 'utf8',
    env: { ...process.env, O8_DATA_DIR: state.dir, O8_MASTER_KEY: key, O8_TEST_DISABLE_VOICE_PROVIDER_KEYS: '1', OPENROUTER_API_KEY: '', GEMINI_API_KEY: '', GROQ_API_KEY: '', ELEVENLABS_API_KEY: '', GOOGLE_TTS_API_KEY: '' },
  }));
}
function restartedNode(name: string) {
  return JSON.parse(execFileSync(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', '-e',
    'const {resolveProviderKey}=require("./src/lib/providers/key-store.ts");process.stdout.write(JSON.stringify(resolveProviderKey(process.argv[1])))', name], {
    encoding: 'utf8', env: { ...process.env, O8_DATA_DIR: state.dir, O8_MASTER_KEY: master },
  }));
}
beforeAll(() => {
  execFileSync('cargo', ['build', '--manifest-path', 'tests/provider-keys/Cargo.toml', '--quiet'], { stdio: 'pipe', timeout: 180_000 });
}, 180_000);
beforeEach(() => {
  rmSync(state.dir, { recursive: true, force: true }); mkdirSync(state.dir);
  vi.stubEnv('O8_MASTER_KEY', master); vi.stubEnv('OPENROUTER_API_KEY', '');
  clearMasterKeyCache();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { limit_remaining: 10 } })));
});
afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); clearMasterKeyCache(); rmSync(state.dir, { recursive: true, force: true }); });

it('signed-out API save, check, rotation, disable and remove reach native consumers across restart', async () => {
  expect((await routes.POST(request('POST', { provider: 'openrouter', key: 'fixture-node-first' }))).status).toBe(200);
  expect(native({ action: 'read' }).value).toBe('fixture-node-first');
  expect(native({ action: 'public' }).value.openrouter_api_key_set).toBe(true);
  expect(restartedNode('OPENROUTER_API_KEY')).toBe('fixture-node-first');
  expect((await routes.PATCH(request('PATCH', { provider: 'openrouter', check: true }))).status).toBe(200);
  expect(fetch).toHaveBeenLastCalledWith('https://openrouter.ai/api/v1/key', expect.objectContaining({ headers: { Authorization: 'Bearer fixture-node-first' } }));
  await routes.POST(request('POST', { provider: 'openrouter', key: 'fixture-node-rotated' }));
  expect(native({ action: 'read' }).value).toBe('fixture-node-rotated');
  await routes.PATCH(request('PATCH', { provider: 'openrouter', enabled: false }));
  expect(native({ action: 'read' }).value).toBeNull();
  expect(restartedNode('OPENROUTER_API_KEY')).toBeNull();
  expect(native({ action: 'public' }).value.openrouter_api_key_set).toBe(true);
  expect(native({ action: 'save', pref: 'openrouter_enabled', value: true }).ok).toBe(true);
  expect(native({ action: 'read' }).value).toBe('fixture-node-rotated');
  expect(resolveProviderKey('OPENROUTER_API_KEY')).toBe('fixture-node-rotated');
  await routes.DELETE(request('DELETE', { provider: 'openrouter' }));
  // A stale plaintext legacy slot must not resurrect a removed key.
  writeFileSync(join(state.dir, 'dictation.json'), JSON.stringify({ openrouter_api_key: 'fixture-legacy-stale' }));
  expect(native({ action: 'read' }).value).toBeNull();
  expect(native({ action: 'public' }).value.openrouter_api_key_set).toBe(false);
  expect(restartedNode('OPENROUTER_API_KEY')).toBeNull();
});
it.each([
  ['openrouter_api_key', 'OPENROUTER_API_KEY'], ['gemini_api_key', 'GEMINI_API_KEY'],
  ['groq_api_key', 'GROQ_API_KEY'], ['elevenlabs_api_key', 'ELEVENLABS_API_KEY'], ['google_tts_api_key', 'GOOGLE_TTS_API_KEY'],
])('native %s saves and removes the Node-readable encrypted credential across restart', async (pref, name) => {
  expect(native({ action: 'save', pref, value: 'fixture-native-first' }).ok).toBe(true);
  expect(resolveProviderKey(name)).toBe('fixture-native-first');
  expect(restartedNode(name)).toBe('fixture-native-first');
  expect(readFileSync(join(state.dir, '.env.local'), 'utf8')).not.toContain('fixture-native-first');
  expect(readFileSync(join(state.dir, 'dictation.json'), 'utf8')).not.toContain('fixture-native-first');
  expect(native({ action: 'save', pref, value: 'fixture-native-rotated' }).ok).toBe(true);
  expect(resolveProviderKey(name)).toBe('fixture-native-rotated');
  expect(native({ action: 'save', pref, value: '' }).ok).toBe(true);
  expect(resolveProviderKey(name)).toBeNull();
  expect(restartedNode(name)).toBeNull();
});
it('a denied master key and a busy store preserve persisted state in both writers', async () => {
  await routes.POST(request('POST', { provider: 'openrouter', key: 'fixture-protected' }));
  const path = join(state.dir, '.env.local'); const original = readFileSync(path, 'utf8');
  const wrong = Buffer.alloc(32, 38).toString('base64url');
  expect(native({ action: 'save', pref: 'openrouter_api_key', value: 'fixture-refused' }, wrong).ok).toBe(false);
  expect(native({ action: 'save', pref: 'openrouter_api_key', value: '' }, wrong).ok).toBe(false);
  expect(native({ action: 'save', pref: 'openrouter_enabled', value: false }, wrong).ok).toBe(false);
  expect(readFileSync(path, 'utf8')).toBe(original);
  vi.stubEnv('O8_MASTER_KEY', wrong); clearMasterKeyCache();
  expect((await routes.DELETE(request('DELETE', { provider: 'openrouter' }))).status).toBe(503);
  expect(readFileSync(path, 'utf8')).toBe(original);
  vi.stubEnv('O8_MASTER_KEY', master); clearMasterKeyCache();
  const lock = new Database(join(state.dir, '.provider-keys.lock'));
  lock.exec('BEGIN EXCLUSIVE');
  expect(native({ action: 'save', pref: 'openrouter_api_key', value: '' }).ok).toBe(false);
  expect((await routes.DELETE(request('DELETE', { provider: 'openrouter' }))).status).toBe(503);
  expect(readFileSync(path, 'utf8')).toBe(original);
  expect(native({ action: 'read' }).value).toBe('fixture-protected');
  lock.close();
});

it('legacy native migration cannot overwrite a concurrent removal or rotation', () => {
  expect(native({ action: 'save', pref: 'openrouter_api_key', value: 'fixture-new' }).ok).toBe(true);
  expect(native({ action: 'migrate', name: 'OPENROUTER_API_KEY', value: 'fixture-stale' }).value).toBe('fixture-new');
  expect(native({ action: 'save', pref: 'openrouter_api_key', value: '' }).ok).toBe(true);
  expect(native({ action: 'migrate', name: 'OPENROUTER_API_KEY', value: 'fixture-stale' }).value).toBeNull();
  expect(restartedNode('OPENROUTER_API_KEY')).toBeNull();
});
it('an exited lock owner releases the store so a restarted writer can save', () => {
  // The fixture exits with a live uncommitted SQLite lock, bypassing Drop/close.
  expect(native({ action: 'crash-lock' }).ok).toBe(true);
  expect(native({ action: 'save', pref: 'openrouter_api_key', value: 'fixture-recovered' }).ok).toBe(true);
  expect(restartedNode('OPENROUTER_API_KEY')).toBe('fixture-recovered');
});

it.each([
  ['gemini', 'gemini_api_key'], ['groq', 'groq_api_key'], ['elevenlabs', 'elevenlabs_api_key'], ['google_tts', 'google_tts_api_key'],
])('API %s credentials and disable/remove decisions reach the native consumer', async (provider, pref) => {
  expect((await routes.POST(request('POST', { provider, key: 'fixture-provider-shared' }))).status).toBe(200);
  expect(native({ action: 'read', pref }).value).toBe('fixture-provider-shared');
  await routes.PATCH(request('PATCH', { provider, enabled: false }));
  expect(native({ action: 'read', pref }).value).toBeNull();
  await routes.PATCH(request('PATCH', { provider, enabled: true }));
  expect(native({ action: 'read', pref }).value).toBe('fixture-provider-shared');
  await routes.DELETE(request('DELETE', { provider }));
  expect(native({ action: 'read', pref }).value).toBeNull();
});
it('disabled legacy migration retains its source and empty unmanaged slots can migrate', () => {
  writeFileSync(join(state.dir, 'dictation.json'), JSON.stringify({ openrouter_api_key: 'fixture-legacy', language: 'en' }));
  expect(native({ action: 'save', pref: 'openrouter_enabled', value: false }).ok).toBe(true);
  expect(native({ action: 'migrate', name: 'OPENROUTER_API_KEY', value: 'fixture-legacy' }).value).toBeNull();
  expect(JSON.parse(readFileSync(join(state.dir, 'dictation.json'), 'utf8')).openrouter_api_key).toBe('fixture-legacy');
  writeFileSync(join(state.dir, '.env.local'), 'OPENROUTER_API_KEY=\n');
  expect(native({ action: 'migrate', name: 'OPENROUTER_API_KEY', value: 'fixture-legacy' }).value).toBe('fixture-legacy');
  expect(restartedNode('OPENROUTER_API_KEY')).toBe('fixture-legacy');
});

it.each([['openai', 'OPENAI_API_KEY'], ['anthropic', 'ANTHROPIC_API_KEY'], ['gemini', 'GEMINI_API_KEY']])('the selected %s chat provider refreshes credentials from the store', async (provider, name) => {
  const selected = provider === 'gemini' ? 'google' : provider as 'openai' | 'anthropic';
  await routes.POST(request('POST', { provider, key: 'fixture-chat-key' }));
  expect(resolveApiKey(selected)).toBe('fixture-chat-key');
  await routes.PATCH(request('PATCH', { provider, enabled: false }));
  expect(resolveApiKey(selected)).toBeNull();
  await routes.DELETE(request('DELETE', { provider }));
  expect(restartedNode(name)).toBeNull();
});

it('standard-base64 master overrides remain compatible and empty legacy entries remain absent', async () => {
  const standard = Buffer.alloc(32, 251).toString('base64');
  vi.stubEnv('O8_MASTER_KEY', standard); clearMasterKeyCache();
  writeFileSync(join(state.dir, '.env.local'), 'GEMINI_API_KEY=\n');
  expect((await routes.POST(request('POST', { provider: 'openrouter', key: 'fixture-standard-master' }))).status).toBe(200);
  expect(native({ action: 'read' }, standard).value).toBe('fixture-standard-master');
  expect(native({ action: 'save', pref: 'groq_api_key', value: 'fixture-groq' }, standard).ok).toBe(true);
  expect(native({ action: 'public' }, standard).value.gemini_api_key_set).toBe(false);
  expect(resolveProviderKey('GROQ_API_KEY')).toBe('fixture-groq');
});

it.each([['save', 'native'], ['remove', 'native'], ['save', 'node'], ['remove', 'node']])('API %s retries blocked legacy plaintext cleanup from %s readers after restart', async (action, reader) => {
  writeFileSync(join(state.dir, 'dictation.json'), JSON.stringify({ openrouter_api_key: 'fixture-old-plaintext', language: 'en' }));
  const prefsLock = new Database(join(state.dir, '.voice-prefs.lock'));
  prefsLock.exec('BEGIN EXCLUSIVE');
  try {
    expect((await routes.POST(request('POST', { provider: 'openrouter', key: 'fixture-authoritative-key' }))).status).toBe(200);
    if (action === 'remove') expect((await routes.DELETE(request('DELETE', { provider: 'openrouter' }))).status).toBe(200);
    expect(JSON.parse(readFileSync(join(state.dir, 'dictation.json'), 'utf8')).openrouter_api_key).toBe('fixture-old-plaintext');
    expect(native({ action: 'read' }).value).toBe(action === 'remove' ? null : 'fixture-authoritative-key');
  } finally { prefsLock.close(); }
  const resolved = reader === 'native' ? native({ action: 'read' }).value : restartedNode('OPENROUTER_API_KEY');
  expect(resolved).toBe(action === 'remove' ? null : 'fixture-authoritative-key');
  expect(JSON.parse(readFileSync(join(state.dir, 'dictation.json'), 'utf8'))).toEqual({ language: 'en' });
});
it('API persistence cleans an existing plaintext slot without waiting for native use', async () => {
  writeFileSync(join(state.dir, 'dictation.json'), JSON.stringify({ openrouter_api_key: 'fixture-old-plaintext', language: 'en' }));
  expect((await routes.POST(request('POST', { provider: 'openrouter', key: 'fixture-api-key' }))).status).toBe(200);
  expect(JSON.parse(readFileSync(join(state.dir, 'dictation.json'), 'utf8'))).toEqual({ language: 'en' });
});
