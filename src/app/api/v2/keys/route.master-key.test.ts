import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ invalidateRuntimeAuthCache: vi.fn() }));
state.dir = mkdtempSync(join(tmpdir(), 'o8-master-route-'));
// The resolver's direct require uses this same built-in module. No real Keychain access.
const childProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
const security = vi.spyOn(childProcess, 'execSync').mockImplementation(() => { throw Object.assign(new Error('fixture Keychain item absent'), { status: 44 }); });
const { clearMasterKeyCache } = await import('@/lib/db/master-key');
const { resolveProviderKey } = await import('@/lib/providers/key-store');
const routes = await import('./route');
const originalKey = Buffer.alloc(32, 51).toString('base64url');
const keyPath = () => join(state.dir, 'master-key');
const envPath = () => join(state.dir, '.env.local');
const post = (key: string) => routes.POST(new NextRequest('http://localhost/api/v2/keys', {
  method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ provider: 'openrouter', key }),
}));
beforeEach(() => {
  rmSync(state.dir, { recursive: true, force: true });
  vi.stubEnv('O8_DATA_DIR', state.dir); vi.stubEnv('O8_MASTER_KEY', ''); vi.stubEnv('OPENROUTER_API_KEY', '');
  clearMasterKeyCache();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
});
afterAll(() => { security.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); clearMasterKeyCache(); rmSync(state.dir, { recursive: true, force: true }); });

it.each(['remove', 'corrupt', 'replace'])('refuses a second real-route save after backing master-key %s without damaging earlier data', async (action) => {
  const { mkdirSync } = await import('node:fs'); mkdirSync(state.dir, { mode: 0o700 });
  writeFileSync(keyPath(), originalKey, { mode: 0o600 });
  expect((await post('fixture-original-secret')).status).toBe(200);
  const originalStore = readFileSync(envPath(), 'utf8');
  if (action === 'remove') rmSync(keyPath());
  else writeFileSync(keyPath(), action === 'corrupt' ? 'broken' : Buffer.alloc(32, 52).toString('base64url'));
  const response = await post('fixture-refused-secret');
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'master_key_unavailable' });
  expect(readFileSync(envPath(), 'utf8')).toBe(originalStore);
  if (action === 'remove') expect(() => readFileSync(keyPath())).toThrow();
  else expect(readFileSync(keyPath(), 'utf8')).toBe(action === 'corrupt' ? 'broken' : Buffer.alloc(32, 52).toString('base64url'));
  writeFileSync(keyPath(), originalKey, { mode: 0o600 });
  clearMasterKeyCache();
  expect(resolveProviderKey('OPENROUTER_API_KEY')).toBe('fixture-original-secret');
});
it.skipIf(process.platform === 'win32')('tightens fallback key and directory permissions before a real-route save', async () => {
  const { mkdirSync } = await import('node:fs'); mkdirSync(state.dir, { mode: 0o755 }); chmodSync(state.dir, 0o755);
  writeFileSync(keyPath(), originalKey, { mode: 0o644 }); chmodSync(keyPath(), 0o644);
  expect((await post('fixture-permissions')).status).toBe(200);
  expect(statSync(state.dir).mode & 0o777).toBe(0o700);
  expect(statSync(keyPath()).mode & 0o777).toBe(0o600);
});

it('refuses a second real-route save when a cached Keychain key becomes denied', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  security.mockReturnValue(originalKey);
  try {
    expect((await post('fixture-keychain-original')).status).toBe(200);
    const originalStore = readFileSync(envPath(), 'utf8');
    security.mockImplementation(() => { throw Object.assign(new Error('fixture Keychain denied'), { status: 36 }); });
    const response = await post('fixture-keychain-refused');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'master_key_unavailable' });
    expect(readFileSync(envPath(), 'utf8')).toBe(originalStore);
    security.mockReturnValue(originalKey); clearMasterKeyCache();
    expect(resolveProviderKey('OPENROUTER_API_KEY')).toBe('fixture-keychain-original');
  } finally {
    Object.defineProperty(process, 'platform', platform);
    security.mockImplementation(() => { throw Object.assign(new Error('fixture Keychain item absent'), { status: 44 }); });
  }
});
it('accepts the Windows fallback without requiring POSIX mode bits', async () => {
  const { mkdirSync } = await import('node:fs'); mkdirSync(state.dir);
  writeFileSync(keyPath(), originalKey, { mode: 0o600 });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { expect((await post('fixture-windows-key')).status).toBe(200); }
  finally { Object.defineProperty(process, 'platform', platform); }
});
