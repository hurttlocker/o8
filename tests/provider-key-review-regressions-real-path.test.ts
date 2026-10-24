import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync as rawExec } from 'node:child_process';
const s = vi.hoisted(() => ({ home: '', dir: '' }));
vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), homedir: () => s.home }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => s.dir, migrateDataDirOnce: () => {} }));
vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => ({ entries: [] }) }));
vi.mock('@/lib/mcp/tool-spine/emit-claude', () => ({ toClaudeJson: () => ({ mcpServers: {} }) }));
s.home = mkdtempSync(join(tmpdir(), 'o8-pr4280-fixture-'));
s.dir = join(s.home, 'data');
mkdirSync(s.dir);
const { mutateProviderKey } = await import('@/lib/providers/key-store');
const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
const cp = await import('@/lib/providers/child-process');
const { AcpClient } = await import('@/lib/acp/client');
const { runRuleCheck } = await import('@/lib/supervisor/rule-check');
const saved = 'fixture-review-provider';
beforeEach(() => {
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 73).toString('base64url'));
  vi.stubEnv('HOME', s.home);
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('CODEX_API_KEY', '');
  for (const f of ['.env.local', 'owned-credential-artifacts.json'])
    rmSync(join(s.dir, f), { force: true });
  rmSync(join(s.dir, 'runtime-billing'), { force: true, recursive: true });
  rmSync(join(s.home, '.hermes'), { recursive: true, force: true });
  mutateProviderKey('OPENAI_API_KEY', { key: saved });
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(s.home, { force: true, recursive: true }); });
it('unidentified ACP launch does not receive a saved key from a prepared owned Hermes home', async () => {
  const home = join(s.dir, 'hermes-o8', 'prepared');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: saved }));
  writeFileSync(join(home, 'config.yaml'), '');
  const { encryptValueSync } = await import('@/lib/db/master-key');
  const file = join(home, 'auth.json');
  const encrypted = encryptValueSync(JSON.stringify({ path: realpathSync(file), runtime: 'hermes', owner: 'o8', contents: '{}' }));
  writeFileSync(join(s.dir, 'owned-credential-artifacts.json'), JSON.stringify([{ path: realpathSync(file), runtime: 'hermes', owner: 'o8', replacement: `enc:${encrypted.iv}:${encrypted.ciphertext}` }]));
  const peer = join(s.home, 'acp-peer.cjs');
  writeFileSync(peer, `const fs=require('node:fs'),p=require('node:path');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:1}:m.method==='session/new'?{sessionId:'review',configOptions:[{id:'model',type:'select',currentValue:String(JSON.parse(fs.readFileSync(p.join(process.env.HERMES_HOME,'auth.json'),'utf8')).OPENAI_API_KEY!==undefined),options:[]}]}:{}})+'\\n')});`.replaceAll("'\\\\n'", "'\\n'"));
  expect(() => new AcpClient({ command: process.execPath, args: [peer], env: { HERMES_HOME: home } } as never)).toThrow(/#4340/);
  expect(readFileSync(join(home, 'auth.json'), 'utf8')).toContain(saved);
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


it('YAML warnings never surface provider credential values at actual Hermes preparation', async () => {
  const hermes = join(s.home, '.hermes'); mkdirSync(hermes, { recursive: true });
  writeFileSync(join(hermes, 'config.yaml'), `model:\n  provider: openai\n  api_key: !unrecognized ${saved}\n`);
  const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  const { governHermesProfile } = await import('@/lib/lane/orchestrator-backends/hermes-profile');
  let error: unknown;
  try { governHermesProfile(process.execPath); } catch (caught) { error = caught; }
  try {
    expect(JSON.stringify(warning.mock.calls)).not.toContain(saved);
    expect(String(error ?? '')).not.toContain(saved);
  } finally { warning.mockRestore(); }
});
it('preserves unrelated global Git configuration for utility children', () => {
  writeFileSync(join(s.home, '.gitconfig'), '[user]\n  name = Fixture\n');
  vi.stubEnv('GIT_CONFIG_GLOBAL', undefined);
  const name = cp.execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8' });
  expect(name.trim()).toBe('Fixture');
});
