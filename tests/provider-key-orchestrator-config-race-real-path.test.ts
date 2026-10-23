import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
const state = vi.hoisted(() => ({ home: '', dir: '', binary: '', record: '', gate: async () => {} }));
vi.mock('node:os', async real => ({ ...await real<typeof import('node:os')>(), homedir: () => state.home }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir, migrateDataDirOnce: () => {} }));
vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({ CliNotFoundError: class extends Error {}, resolveCli: async () => { await state.gate(); return { path: state.binary, version: '0.140.0' }; } }));
vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => ({ entries: [] }) }));
state.home = mkdtempSync(join(tmpdir(), 'o8-orchestrator-config-race-')); state.dir = join(state.home, 'data'); mkdirSync(state.dir);
const repo = join(state.home, 'repo'); mkdirSync(repo); execFileSync('git', ['init', '-q', repo]);
state.binary = join(state.home, 'fixture-codex'); state.record = join(state.home, 'observed.json');
writeFileSync(state.binary, `#!/usr/bin/env node
const fs=require('node:fs'),p=require('node:path');fs.writeFileSync(${JSON.stringify(state.record)},JSON.stringify({env:process.env.OPENAI_API_KEY||null,config:fs.readFileSync(p.join(process.env.CODEX_HOME,'config.toml'),'utf8')}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Fixture'}}));
`); chmodSync(state.binary, 0o755);
const keys = await import('@/app/api/v2/keys/route'); const billing = await import('@/app/api/runtime/billing/route');
const orchestrator = await import('@/lib/lane/codex-orchestrator-session');
const request = (path: string, body: unknown, method = 'POST') => new NextRequest(`http://localhost/api/${path}`, { method, headers: { host: 'localhost' }, body: JSON.stringify(body) });
function copies(dir = state.dir): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? copies(join(dir, entry.name)) : entry.name === 'config.toml' ? [join(dir, entry.name)] : []); }
beforeEach(async () => {
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 92).toString('base64url')); vi.stubEnv('O8_CRASH_SURVIVABLE_ORCHESTRATOR', '0');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
  mkdirSync(join(state.home, '.codex'), { recursive: true });
  writeFileSync(join(state.home, '.codex/config.toml'), '[model_providers.openai.http_headers]\nAuthorization="Bearer fixture-orchestrator-key"\n');
  expect((await billing.POST(request('runtime/billing', { runtimeId: 'codex', mode: 'api' }))).status).toBe(200);
  expect((await keys.POST(request('v2/keys', { provider: 'openai', key: 'fixture-orchestrator-key' }))).status).toBe(200);
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(state.home, { force: true, recursive: true }); });
it('revoke and subscription while CLI resolution waits cannot reach an owned config or the actual child', async () => {
  let entered!: () => void; let release!: () => void;
  const waiting = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
  state.gate = async () => { entered(); await gate; };
  const pending = orchestrator.sendToCodexOrchestrator(orchestrator.ensureCodexOrchestratorSession(repo), 'Fixture', () => {}, { model: 'gpt-5.5' });
  await waiting;
  try {
    expect(copies().every(file => !readFileSync(file, 'utf8').includes('fixture-orchestrator-key'))).toBe(true);
    vi.resetModules(); const restarted = await import('@/app/api/v2/keys/route');
    expect((await restarted.DELETE(request('v2/keys', { provider: 'openai' }, 'DELETE'))).status).toBe(200);
    expect((await billing.POST(request('runtime/billing', { runtimeId: 'codex', mode: 'subscription' }))).status).toBe(200);
    expect(copies().every(file => !readFileSync(file, 'utf8').includes('fixture-orchestrator-key'))).toBe(true);
  } finally { release(); await pending; }
  const observed = (() => { try { return JSON.parse(readFileSync(state.record, 'utf8')); } catch { return null; } })();
  if (observed) { expect(observed.env).toBeNull(); expect(observed.config).not.toContain('fixture-orchestrator-key'); }
  expect(readFileSync(join(state.home, '.codex/config.toml'), 'utf8')).toContain('fixture-orchestrator-key');
});
