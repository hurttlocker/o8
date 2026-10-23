import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync as rawExec } from 'node:child_process';
const s = vi.hoisted(() => ({ home: '', dir: '', authFile: '', swapAuth: '' }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
    const raw = fs.readFileSync(...args);
    if (s.swapAuth && String(args[0]) === s.authFile) {
      const replacement = s.swapAuth; s.swapAuth = '';
      fs.writeFileSync(s.authFile, replacement);
    }
    return raw;
  }) as typeof fs.readFileSync };
});
vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), homedir: () => s.home }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => s.dir, migrateDataDirOnce: () => {} }));
vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => ({ entries: [] }) }));
vi.mock('@/lib/mcp/tool-spine/emit-claude', () => ({ toClaudeJson: () => ({ mcpServers: {} }) }));
s.home = mkdtempSync(join(tmpdir(), 'o8-pr4280-fixture-'));
s.dir = join(s.home, 'data');
mkdirSync(s.dir);
const source = join(s.home, '.codex');
mkdirSync(source);
s.authFile = join(source, 'auth.json');
const { mutateProviderKey } = await import('@/lib/providers/key-store');
const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
const { childEnvironment } = await import('@/lib/providers/spawn-environment');
const cp = await import('@/lib/providers/child-process');
const { AcpClient } = await import('@/lib/acp/client');
const { runRuleCheck } = await import('@/lib/supervisor/rule-check');
const saved = 'fixture-review-provider';
const observer = join(s.home, 'observe.cjs');
writeFileSync(observer, `const fs=require('node:fs'),p=require('node:path');const home=process.env.CODEX_HOME;process.stdout.write(JSON.stringify({home,auth:JSON.parse(fs.readFileSync(p.join(home,'auth.json'),'utf8'))}));`);
beforeEach(() => {
  s.swapAuth = '';
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 73).toString('base64url'));
  vi.stubEnv('HOME', s.home);
  vi.stubEnv('CODEX_HOME', source);
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('CODEX_API_KEY', '');
  for (const f of ['.env.local', 'owned-credential-artifacts.json'])
    rmSync(join(s.dir, f), { force: true });
  rmSync(join(s.dir, 'runtime-billing'), { force: true, recursive: true });
  writeFileSync(join(source, 'config.toml'), '');
  writeFileSync(join(source, 'auth.json'), JSON.stringify({ tokens: { access_token: 'old-access', refresh_token: 'old-single-use-refresh' } }));
  mutateProviderKey('OPENAI_API_KEY', { key: saved });
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(s.home, { force: true, recursive: true }); });
it('preserves OAuth refreshed by the previous Codex child', () => {
  const opts = () => ({ env: childEnvironment({ runtimeId: 'codex' }), encoding: 'utf8' as const });
  const first = JSON.parse(cp.execFileSync(process.execPath, [observer], opts()));
  const refresh = join(s.home, 'refresh.cjs');
  writeFileSync(refresh, `require('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME,'auth.json'),JSON.stringify({tokens:{access_token:'fresh-access',refresh_token:'fresh-single-use-refresh'}}));`);
  cp.execFileSync(process.execPath, [refresh], opts());
  expect(JSON.parse(readFileSync(join(first.home, 'auth.json'), 'utf8')).tokens.refresh_token).toBe('fresh-single-use-refresh');
  const second = JSON.parse(cp.execFileSync(process.execPath, [observer], opts()));
  expect(second.auth.tokens.refresh_token).toBe('fresh-single-use-refresh');
  writeFileSync(s.authFile, JSON.stringify({ OPENAI_API_KEY: saved, tokens: { refresh_token: 'old-single-use-refresh', access_token: 'old-access' } }));
  expect(JSON.parse(cp.execFileSync(process.execPath, [observer], opts())).auth.tokens.refresh_token).toBe('fresh-single-use-refresh');
  writeFileSync(s.authFile, JSON.stringify({ tokens: { refresh_token: 'older-source-refresh' } }));
  utimesSync(s.authFile, 1, 1);
  expect(JSON.parse(cp.execFileSync(process.execPath, [observer], opts())).auth.tokens.refresh_token).toBe('fresh-single-use-refresh');
  writeFileSync(join(source, 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'new-source-login' } }));
  expect(JSON.parse(cp.execFileSync(process.execPath, [observer], opts())).auth.tokens.refresh_token).toBe('new-source-login');
});
it('unidentified ACP launch does not receive a saved key from a prepared owned Codex home', async () => {
  const home = join(s.dir, 'codex-orchestrator', 'prepared');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: saved }));
  writeFileSync(join(home, 'config.toml'), '');
  const peer = join(s.home, 'acp-peer.cjs');
  writeFileSync(peer, `const fs=require('node:fs'),p=require('node:path');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:1}:m.method==='session/new'?{sessionId:'review',configOptions:[{id:'model',type:'select',currentValue:String(JSON.parse(fs.readFileSync(p.join(process.env.CODEX_HOME,'auth.json'),'utf8')).OPENAI_API_KEY!==undefined),options:[]}]}:{}})+'\\n')});`.replaceAll("'\\\\n'", "'\\n'"));
  const client = new AcpClient({ command: process.execPath, args: [peer], env: { CODEX_HOME: home } } as never);
  try {
    await client.initialize();
    const session = await client.newSession(s.home, []);
    expect(session.configOptions[0].currentValue).toBe('false');
  }
  finally {
    client.kill();
  }
});
it('git-backed guard catches createRequire aliases and destructuring', async () => {
  const fixture = join(s.home, 'guard');
  mkdirSync(fixture, { recursive: true });
  rawExec('git', ['init', '--quiet', fixture]);
  rawExec('git', ['-C', fixture, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'baseline']);
  const dir = join(fixture, 'src/lib');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'launch.ts'), `import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); const {spawn: launch}=require('node:child_process'); launch('codex');\n`);
  const result = await runRuleCheck(fixture, 'HEAD');
  expect(result.violations.some(v => v.rule === 'child-process-boundary')).toBe(true);
});
it('disabling OpenRouter through the API still disables native Symon', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
  const { NextRequest } = await import('next/server');
  const keys = await import('@/app/api/v2/keys/route');
  const req = (body: unknown, method = 'POST') => new NextRequest('http://localhost/api/v2/keys', { method, headers: { host: 'localhost' }, body: JSON.stringify(body) });
  try {
    expect((await keys.POST(req({ provider: 'openrouter', key: 'fixture-review-openrouter' }))).status).toBe(200);
    expect((await keys.PATCH(req({ provider: 'openrouter', enabled: false }, 'PATCH'))).status).toBe(200);
    // This is the persisted input actually read by src-tauri/src/stt/keys.rs:368.
    expect(JSON.parse(readFileSync(join(s.dir, 'providers/openrouter.json'), 'utf8')).enabled).toBe(false);
  }
  finally {
    vi.unstubAllGlobals();
  }
});
it.each([false, true])('Claude orchestrator applies billing revocation at its turn receipt (warm=%s)', async (warm) => {
  const repo = join(s.home, `repo-${warm}`);
  mkdirSync(repo, { recursive: true });
  rawExec('git', ['init', '--quiet', repo]);
  const binary = join(s.home, 'fixture-claude'), record = join(s.home, 'claude-observed.json');
  writeFileSync(binary, `#!/usr/bin/env node
const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({keyPresent:!!process.env.ANTHROPIC_API_KEY,promptReceived:true,pid:process.pid}));console.log(JSON.stringify({type:'result',session_id:'review-fixture',is_error:false}));});`);
  const { chmodSync } = await import('node:fs');
  chmodSync(binary, 0o755);
  vi.stubEnv('O8_CLAUDE_CODE_BIN', binary);
  vi.stubEnv('O8_CRASH_SURVIVABLE_ORCHESTRATOR', '0');
  mutateProviderKey('ANTHROPIC_API_KEY', { key: 'fixture-review-anthropic' });
  saveRuntimeBillingMode('claude-code', 'api');
  const o = await import('@/lib/lane/orchestrator-session');
  const session = o.ensureOrchestratorSession(repo);
  try {
    let previousPid: number | undefined;
    if (warm) {
      await o.sendToOrchestrator(session, 'first prompt', () => {});
      previousPid = JSON.parse(readFileSync(record, 'utf8')).pid;
    }
    await o.sendToOrchestrator(session, 'synthetic prompt', event => { if (event.type === 'turn_receipt')
      saveRuntimeBillingMode('claude-code', 'subscription'); });
    const result = JSON.parse(readFileSync(record, 'utf8'));
    expect(result).toMatchObject({ keyPresent: false, promptReceived: true });
    if (warm)
      expect(result.pid).not.toBe(previousPid);
  }
  finally {
    o.reloadOrchestratorSession(repo);
  }
});
it('malformed credential config does not leak a saved provider key in its error', async () => {
  const hermes = join(s.home, '.hermes');
  mkdirSync(hermes, { recursive: true });
  writeFileSync(join(hermes, 'config.yaml'), ['model:', '  provider: openai', `  api_key: "${saved}`, ''].join('\n'));
  const { governHermesProfile } = await import('@/lib/lane/orchestrator-backends/hermes-profile');
  let error: unknown;
  try {
    governHermesProfile(process.execPath);
  }
  catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message.includes(saved)).toBe(false);
});

it('refuses a source-auth change during capture without overwriting refreshed child auth', () => {
  const opts = () => ({ env: childEnvironment({ runtimeId: 'codex' }), encoding: 'utf8' as const });
  const first = JSON.parse(cp.execFileSync(process.execPath, [observer], opts()));
  const retained = JSON.stringify({ tokens: { refresh_token: 'fixture-child-refreshed' } });
  writeFileSync(join(first.home, 'auth.json'), retained);
  s.swapAuth = JSON.stringify({ tokens: { refresh_token: 'fixture-concurrent-source' } });
  expect(() => cp.execFileSync(process.execPath, [observer], opts())).toThrow(/source authentication changed/);
  expect(readFileSync(join(first.home, 'auth.json'), 'utf8')).toBe(retained);
});

it.each(['legacy', 'absent'])('honors source logout when adopting %s overlay state', mode => {
  const launch = () => JSON.parse(cp.execFileSync(process.execPath, [observer], {
    env: childEnvironment({ runtimeId: 'codex' }), encoding: 'utf8',
  }));
  const first = launch();
  const sidecar = join(first.home, 'auth-source.sha256');
  if (mode === 'legacy') writeFileSync(sidecar, 'a'.repeat(64));
  else rmSync(sidecar);
  rmSync(s.authFile);
  expect(launch().auth).toEqual({});
  expect(launch().auth).toEqual({});
});
