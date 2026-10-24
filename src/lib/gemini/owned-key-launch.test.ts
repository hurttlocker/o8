import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownedSpawnEnvironment } from '@/lib/runtimes/shared/owned-session/restricted-spawn-env';
import { saveRuntimeBillingMode } from '@/lib/providers/runtime-billing';
import type { OwnedRuntimeAdapter, OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

const state = vi.hoisted(() => ({ dir: '', childKeys: null as Record<string, string | null> | null }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
vi.mock('@/lib/runtimes/shared/owned-session', () => ({
  createOwnedSessionStore: (adapter: OwnedRuntimeAdapter) => ({
    launch: async () => {
      // Exercise the registered production launch hook and its child environment.
      const session = { surfaceId: 'gemini-owned:fixture' } as OwnedSessionRecord;
      const extra = await adapter.extraSpawnEnv?.(session);
      state.childKeys = JSON.parse(execFileSync(process.execPath, ['-e',
        'process.stdout.write(JSON.stringify(Object.fromEntries(["GEMINI_API_KEY","GOOGLE_GENERATIVE_AI_API_KEY","GOOGLE_AI_API_KEY"].map(k=>[k,process.env[k]||null]))))'], {
        encoding: 'utf8', env: ownedSpawnEnvironment(session, extra ?? {}),
      }));
      return { ok: true, surfaceId: 'gemini-owned:fixture', note: '' };
    },
  }),
}));
state.dir = mkdtempSync(join(tmpdir(), 'o8-gemini-key-launch-'));
const { mutateProviderKey } = await import('@/lib/providers/key-store');
const { launchOwnedGeminiSession } = await import('./owned');
beforeEach(() => {
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 45).toString('base64url'));
  vi.stubEnv('GEMINI_API_KEY', '');
  vi.stubEnv('GOOGLE_AI_API_KEY', 'fixture-ai-alias');
  vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'fixture-generative-alias');
  writeFileSync(join(state.dir, '.env.local'), '');
  saveRuntimeBillingMode('gemini', 'api');
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(state.dir, { recursive: true, force: true }); });
it.each(['disabled', 'removed'])('the Gemini launch adapter does not inject a %s credential through aliases', async (action) => {
  mutateProviderKey('GEMINI_API_KEY', { key: 'fixture-saved-key' });
  await launchOwnedGeminiSession({ cwd: state.dir, prompt: 'fixture' });
  expect(state.childKeys?.GEMINI_API_KEY).toBe('fixture-saved-key');
  mutateProviderKey('GEMINI_API_KEY', action === 'disabled' ? { enabled: false } : { key: null });
  await launchOwnedGeminiSession({ cwd: state.dir, prompt: 'fixture' });
  expect(state.childKeys).toEqual({ GEMINI_API_KEY: null, GOOGLE_GENERATIVE_AI_API_KEY: null, GOOGLE_AI_API_KEY: null });
});
