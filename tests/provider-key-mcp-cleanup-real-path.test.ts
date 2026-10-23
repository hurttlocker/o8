import { afterAll, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({ dir: '', session: '', moved: '', outside: '', checks: 0, swap: false }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
vi.mock('node:fs', async original => {
  const real = await original<typeof import('node:fs')>();
  return { ...real, lstatSync: (...args: Parameters<typeof real.lstatSync>) => {
    const stat = real.lstatSync(...args);
    if (args[0] === state.session && state.swap && ++state.checks === 2) {
      state.swap = false;
      real.renameSync(state.session, state.moved);
      real.symlinkSync(state.outside, state.session, 'dir');
    }
    return stat;
  } };
});
state.dir = mkdtempSync(join(tmpdir(), 'o8-mcp-cleanup-race-'));
const keys = await import('@/app/api/v2/keys/route');
const request = (body: unknown, method = 'POST') => new NextRequest('http://localhost/api/v2/keys', {
  method, headers: { host: 'localhost' }, body: JSON.stringify(body),
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(state.dir, { recursive: true, force: true }); });

it('revocation scrubs the opened owned file when its parent is replaced, preserving unrelated files', async () => {
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 86).toString('base64url'));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
  expect((await keys.POST(request({ provider: 'openai', key: 'fixture-owned-mcp-key' }))).status).toBe(200);
  state.session = join(state.dir, 'owned-fixture', 'session');
  state.moved = join(state.dir, 'moved-session'); state.outside = join(state.dir, 'unrelated');
  mkdirSync(state.session, { recursive: true }); mkdirSync(state.outside);
  const name = 'o8-worker-mcp-fixture.json';
  writeFileSync(join(state.session, name), '{"env":{"OPENAI_API_KEY":"fixture-owned-mcp-key"}}');
  writeFileSync(join(state.outside, name), 'fixture-unrelated');
  state.swap = true;
  // The concurrent directory change may reject revocation, but cannot redirect cleanup.
  const response = await keys.DELETE(request({ provider: 'openai' }, 'DELETE'));
  expect([200, 503]).toContain(response.status); expect(state.swap).toBe(false);
  expect(existsSync(join(state.outside, name))).toBe(true);
  expect(readFileSync(join(state.outside, name), 'utf8')).toBe('fixture-unrelated');
  expect(readFileSync(join(state.moved, name), 'utf8')).not.toContain('fixture-owned-mcp-key');
});
