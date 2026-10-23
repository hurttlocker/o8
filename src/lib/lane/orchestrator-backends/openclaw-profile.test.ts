import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
const state = vi.hoisted(() => ({ home: '', data: '' }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => state.home }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.data }));
vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => ({ entries: [] }) }));
state.home = mkdtempSync(join(tmpdir(), 'o8-openclaw-billing-')); state.data = join(state.home, 'data'); mkdirSync(state.data);
const keys = await import('@/app/api/v2/keys/route');
const { prepareOpenclawProfile } = await import('./openclaw-profile');
const request = (path: string, body: unknown, method = 'POST') => new NextRequest(`http://localhost/api/${path}`, { method, headers: { host: 'localhost' }, body: JSON.stringify(body) });
const source = join(state.home, '.openclaw'); const owned = join(state.home, '.openclaw-o8');
const auth = 'agents/main/agent/auth-profiles.json';
const oauth = { type: 'oauth', provider: 'openai-codex', access: 'fixture-oauth-access', refresh: 'fixture-oauth-refresh' };
beforeEach(() => {
  rmSync(join(state.data, 'runtime-billing'), { recursive: true, force: true }); rmSync(owned, { recursive: true, force: true });
  writeFileSync(join(state.data, '.env.local'), '');
  mkdirSync(join(source, 'agents/main/agent'), { recursive: true });
  writeFileSync(join(source, 'openclaw.json'), JSON.stringify({ agents: { list: [{ id: 'main' }] }, service: { headers: { apiKey: 'fixture-service-token' } }, mcp: { servers: { o8: {} } } }));
  writeFileSync(join(source, auth), JSON.stringify({ profiles: { account: oauth } }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 71).toString('base64url'));
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(state.home, { recursive: true, force: true }); });
it('seeds a new subscription profile with OAuth and service auth without changing source files', async () => {
  expect((await keys.POST(request('v2/keys', { provider: 'openai', key: 'fixture-saved-key' }))).status).toBe(200);
  const before = readFileSync(join(source, auth), 'utf8');
  prepareOpenclawProfile(34123);
  expect(JSON.parse(readFileSync(join(owned, auth), 'utf8')).profiles.account).toEqual(oauth);
  expect(JSON.parse(readFileSync(join(owned, 'openclaw.json'), 'utf8')).service.headers.apiKey).toBe('fixture-service-token');
  expect(readFileSync(join(source, auth), 'utf8')).toBe(before);
  expect(readFileSync(join(owned, auth), 'utf8')).not.toContain('fixture-saved-key');
});
it('leaves an earlier profile unchanged and refuses reuse instead of reconciling it', () => {
  prepareOpenclawProfile(34123);
  const file = join(owned, auth), raw = '{"OPENAI_API_KEY":"fixture-older-child-key"}';
  writeFileSync(file, raw);
  expect(() => prepareOpenclawProfile(34123)).toThrow(/#4340/);
  expect(readFileSync(file, 'utf8')).toBe(raw);
});
it('refuses provider Authorization headers before copying instead of rewriting the operator config', () => {
  const file = join(source, 'openclaw.json'), config = JSON.parse(readFileSync(file, 'utf8'));
  config.models = { providers: { openai: { headers: { Authorization: 'Bearer fixture-source-key' } } } };
  const raw = JSON.stringify(config); writeFileSync(file, raw);
  expect(() => prepareOpenclawProfile(34123)).toThrow(/#4340/);
  expect(readFileSync(file, 'utf8')).toBe(raw);
});
