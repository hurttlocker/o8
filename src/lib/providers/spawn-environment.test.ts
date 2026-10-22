import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
state.dir = mkdtempSync(join(tmpdir(), 'o8-spawn-authority-'));
const { providerSpawnEnvironment } = await import('./spawn-environment');
const { mutateProviderKey } = await import('./key-store');
const { ownedSpawnEnvironment } = await import('@/lib/runtimes/shared/owned-session/restricted-spawn-env');
beforeEach(() => {
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 61).toString('base64url'));
  writeFileSync(join(state.dir, '.env.local'), '');
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(state.dir, { recursive: true, force: true }); });
it('injects saved canonical credentials and their aliases instead of inherited overrides', () => {
  mutateProviderKey('GEMINI_API_KEY', { key: 'fixture-saved-gemini' });
  const env = providerSpawnEnvironment({ GEMINI_API_KEY: 'fixture-stale', GOOGLE_API_KEY: 'fixture-stale-alias' });
  expect(env.GEMINI_API_KEY).toBe('fixture-saved-gemini'); expect(env.GOOGLE_API_KEY).toBe('fixture-saved-gemini');
});
it('keeps restricted workers credential-free despite a saved provider key', () => {
  mutateProviderKey('GEMINI_API_KEY', { key: 'fixture-saved-gemini' });
  const env = ownedSpawnEnvironment({ executionPolicy: { mode: 'single-attempt' } } as unknown as OwnedSessionRecord, {});
  expect(env.GEMINI_API_KEY).toBeUndefined(); expect(env.GOOGLE_API_KEY).toBeUndefined();
});
it('preserves an adapter native-auth suppression without re-injecting OpenRouter', () => {
  mutateProviderKey('OPENROUTER_API_KEY', { key: 'fixture-saved-router' });
  expect(ownedSpawnEnvironment({} as OwnedSessionRecord, { OPENROUTER_API_KEY: '' }).OPENROUTER_API_KEY).toBe('');
});
it.each(['openrouter', 'codex-subscription'])('preserves explicit %s gateway transport credentials', source => {
  mutateProviderKey('ANTHROPIC_API_KEY', { key: 'fixture-other-anthropic' });
  const env = ownedSpawnEnvironment({ surfaceId: 'claude-code-owned:fixture', runtimeConfig: { modelSource: source } } as unknown as OwnedSessionRecord, {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1/fixture', ANTHROPIC_AUTH_TOKEN: 'fixture-gateway-token', ANTHROPIC_API_KEY: '',
  });
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe('fixture-gateway-token'); expect(env.ANTHROPIC_API_KEY).toBe('');
});

it.each(['', 'fixture-ambient-xai'])('preserves an explicit unmanaged key through the resolver when ambient is %s', ambient => {
  vi.stubEnv('XAI_API_KEY', ambient);
  expect(providerSpawnEnvironment({ XAI_API_KEY: 'fixture-explicit-xai' }).XAI_API_KEY).toBe('fixture-explicit-xai');
});
