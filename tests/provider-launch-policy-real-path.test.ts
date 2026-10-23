import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
vi.mock('node:os', async real => ({ ...await real<typeof import('node:os')>(), homedir: () => state.dir }));
state.dir = mkdtempSync(join(tmpdir(), 'o8-launch-policy-'));
const master = Buffer.alloc(32, 119).toString('base64url');
const { ensureLaunchPolicy } = await import('@/lib/providers/launch-policy');
const { withProviderStoreLock } = await import('@/lib/providers/store-lock');
const { mutateProviderKey } = await import('@/lib/providers/key-store');
const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
const snapshot = () => withProviderStoreLock(ensureLaunchPolicy);
let nativeBuilt = false;
function native(change: unknown): { ok: boolean } {
  if (!nativeBuilt) {
    execFileSync('cargo', ['build', '--locked', '--manifest-path', resolve('tests/provider-keys/Cargo.toml')], { env: { ...process.env, CARGO_BUILD_JOBS: '2' }, stdio: 'pipe', timeout: 120_000 }); nativeBuilt = true;
  }
  return JSON.parse(execFileSync(resolve(`tests/provider-keys/target/debug/o8-provider-key-tests${process.platform === 'win32' ? '.exe' : ''}`), { input: JSON.stringify(change), encoding: 'utf8', env: { ...process.env, O8_DATA_DIR: state.dir, HOME: state.dir, O8_MASTER_KEY: master, O8_TEST_DISABLE_VOICE_PROVIDER_KEYS: '1' } }));
}
beforeEach(() => { rmSync(state.dir, { force: true, recursive: true }); mkdirSync(state.dir); vi.stubEnv('O8_MASTER_KEY', master); });
afterAll(() => { vi.unstubAllEnvs(); rmSync(state.dir, { force: true, recursive: true }); });

it('Node credential and billing commits invalidate a nonsecret persisted launch generation', () => {
  const initial = snapshot(); expect(snapshot()).toEqual(initial);
  expect(createHash('sha256').update(readFileSync(initial.policyFile)).digest('hex')).toBe(initial.policyHash);
  mutateProviderKey('OPENAI_API_KEY', { key: 'fixture-launch-policy-key' }); const saved = snapshot(); expect(saved.policyHash).not.toBe(initial.policyHash);
  mutateProviderKey('OPENAI_API_KEY', { enabled: false }); const disabled = snapshot(); expect(disabled.policyHash).not.toBe(saved.policyHash);
  mutateProviderKey('OPENAI_API_KEY', { key: null }); const removed = snapshot(); expect(removed.policyHash).not.toBe(disabled.policyHash);
  saveRuntimeBillingMode('codex', 'api'); expect(snapshot().policyHash).not.toBe(removed.policyHash);
  const raw = readFileSync(initial.policyFile, 'utf8'); expect(raw).not.toContain('fixture-launch-policy-key'); expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['epoch', 'version']);
});

it('a restarted native credential mutation invalidates the same generation and Node accepts its format', () => {
  const initial = snapshot();
  expect(native({ action: 'save', pref: 'openrouter_api_key', value: 'fixture-native-launch-policy-key' }).ok).toBe(true);
  const saved = snapshot(); expect(saved.policyFile).toBe(initial.policyFile); expect(saved.policyHash).not.toBe(initial.policyHash);
  expect(native({ action: 'save', pref: 'openrouter_enabled', value: false }).ok).toBe(true);
  expect(snapshot().policyHash).not.toBe(saved.policyHash);
  expect(readFileSync(initial.policyFile, 'utf8')).not.toContain('fixture-native-launch-policy-key');
}, 150_000);

it('Node and native generation changes fail closed while another process owns the store lock', () => {
  const initial = snapshot();
  // Build outside the lock, then run the actual mutation process while held.
  expect(native({ action: 'save', pref: 'openrouter_enabled', value: true }).ok).toBe(true);
  const current = snapshot(); const lock = new Database(join(state.dir, '.provider-keys.lock')); lock.exec('BEGIN EXCLUSIVE');
  try {
    expect(() => snapshot()).toThrow();
    expect(() => mutateProviderKey('OPENAI_API_KEY', { key: 'fixture-busy' })).toThrow();
    expect(() => saveRuntimeBillingMode('codex', 'api')).toThrow();
    expect(native({ action: 'save', pref: 'openrouter_enabled', value: false }).ok).toBe(false);
    expect(createHash('sha256').update(readFileSync(initial.policyFile)).digest('hex')).toBe(current.policyHash);
  } finally { lock.close(); }
}, 150_000);

it.each(['symlink', 'hardlink'])('refuses a %s generation file and preserves the outside target', kind => {
  const initial = snapshot(); rmSync(initial.policyFile);
  const outside = join(state.dir, 'operator-source'); writeFileSync(outside, '{"version":1,"epoch":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n', { mode: 0o600 }); chmodSync(outside, 0o600);
  if (kind === 'symlink') symlinkSync(outside, initial.policyFile); else linkSync(outside, initial.policyFile);
  const before = readFileSync(outside, 'utf8');
  expect(() => snapshot()).toThrow();
  expect(() => mutateProviderKey('OPENAI_API_KEY', { key: 'fixture-linked' })).toThrow();
  expect(native({ action: 'save', pref: 'openrouter_enabled', value: false }).ok).toBe(false);
  expect(readFileSync(outside, 'utf8')).toBe(before);
}, 150_000);
