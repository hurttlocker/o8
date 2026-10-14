import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
state.dir = mkdtempSync(join(tmpdir(), 'o8-key-refresh-'));
beforeEach(() => { vi.resetModules(); vi.stubEnv('OPENROUTER_API_KEY', ''); });
afterAll(() => { vi.unstubAllEnvs(); rmSync(state.dir, { force: true, recursive: true }); });
function siblingWrite(key: string | null) {
  execFileSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', join(state.dir, '.env.local'), key ? `OPENROUTER_API_KEY=${key}\n` : '']);
}
it('refreshes a hydrated credential after another process replaces and removes it', async () => {
  const { resolveOpenRouterKey } = await import('./byok-keys');
  siblingWrite('fixture-first');
  expect(await resolveOpenRouterKey()).toBe('fixture-first');
  siblingWrite('fixture-second');
  expect(await resolveOpenRouterKey()).toBe('fixture-second');
  siblingWrite(null);
  expect(await resolveOpenRouterKey()).toBeNull();
  expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
});
it('preserves an explicit ambient credential when the saved key changes', async () => {
  vi.stubEnv('OPENROUTER_API_KEY', 'fixture-shell');
  const { resolveOpenRouterKey } = await import('./byok-keys');
  siblingWrite('fixture-stored');
  expect(await resolveOpenRouterKey()).toBe('fixture-shell');
  siblingWrite(null);
  expect(await resolveOpenRouterKey()).toBe('fixture-shell');
});
function siblingConnection(enabled: boolean) {
  execFileSync(process.execPath, ['-e', 'const fs=require("node:fs");fs.mkdirSync(process.argv[1],{recursive:true});fs.writeFileSync(process.argv[1]+"/openrouter.json",process.argv[2])', join(state.dir, 'providers'), JSON.stringify({ version: 1, enabled })]);
}
it('stops resolving any OpenRouter key while another process has turned the connection off', async () => {
  const { resolveOpenRouterKey } = await import('./byok-keys');
  siblingWrite('fixture-stored');
  expect(await resolveOpenRouterKey()).toBe('fixture-stored');
  siblingConnection(false);
  expect(await resolveOpenRouterKey()).toBeNull();
  // The injected value leaves this process so later child processes cannot inherit it.
  expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
  vi.stubEnv('OPENROUTER_API_KEY', 'fixture-shell');
  expect(await resolveOpenRouterKey()).toBeNull();
  expect(process.env.OPENROUTER_API_KEY).toBe('fixture-shell');
  siblingConnection(true);
  expect(await resolveOpenRouterKey()).toBe('fixture-shell');
  siblingWrite(null);
});
