import { execFileSync, spawn } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareWorkerSandbox } from './sandbox';

const require = createRequire(import.meta.url);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-sandbox-credential-')));
  roots.push(root);
  const home = join(root, 'home');
  const data = join(home, '.o8');
  const cwd = join(root, 'worktree');
  const profiles = join(root, 'profiles');
  for (const directory of [data, cwd, profiles]) mkdirSync(directory, { recursive: true });
  const lockPath = join(data, '.provider-keys.lock');
  const generation = join(data, 'provider-launch-policy.json');
  writeFileSync(generation, '{"generation":"approved"}');
  writeFileSync(join(data, '.env.local'), 'OPENAI_API_KEY=synthetic-private-key');
  writeFileSync(join(data, 'billing.json'), '{"private":"billing"}');
  new Database(lockPath).close();
  const sqlite = require.resolve('better-sqlite3');
  const codeDirectories = ['better-sqlite3', 'bindings', 'file-uri-to-path'].map(name => dirname(require.resolve(`${name}/package.json`)));
  return { root, home, cwd, profiles, data, lockPath, generation, sqlite, codeDirectories };
}

describe.skipIf(process.platform !== 'darwin')('credential policy access inside the enforced worker sandbox', () => {
  it('locks SQLite and reads only the nonsecret generation while rejecting replacement and policy writes', async () => {
    const input = fixture();
    const before = lstatSync(input.lockPath);
    const script = `
const fs = require('node:fs');
const Database = require(${JSON.stringify(input.sqlite)});
const lock = new Database(${JSON.stringify(input.lockPath)}, { timeout: 0 });
lock.unsafeMode(true);
lock.exec('PRAGMA journal_mode=OFF');
lock.exec('BEGIN EXCLUSIVE');
const result = { generation: JSON.parse(fs.readFileSync(${JSON.stringify(input.generation)}, 'utf8')).generation, denied: [] };
const denied = operation => { try { operation(); result.denied.push(false); } catch { result.denied.push(true); } };
for (const target of ${JSON.stringify([join(input.data, '.env.local'), join(input.data, 'billing.json')])}) denied(() => fs.readFileSync(target));
denied(() => fs.writeFileSync(${JSON.stringify(input.generation)}, 'changed'));
denied(() => fs.unlinkSync(${JSON.stringify(input.lockPath)}));
denied(() => fs.renameSync(${JSON.stringify(input.lockPath)}, ${JSON.stringify(join(input.cwd, 'moved-lock'))}));
fs.writeFileSync(${JSON.stringify(join(input.cwd, 'replacement'))}, 'replacement');
denied(() => fs.renameSync(${JSON.stringify(join(input.cwd, 'replacement'))}, ${JSON.stringify(input.lockPath)}));
denied(() => fs.writeFileSync(${JSON.stringify(join(input.data, 'new-lock'))}, 'replacement'));
denied(() => fs.writeFileSync(${JSON.stringify(join(input.codeDirectories[0], 'lib/index.js'))}, 'changed'));
lock.close();
process.stdout.write(JSON.stringify(result));`;
    const prepared = await prepareWorkerSandbox({
      runId: 'credential-policy', profileDir: input.profiles, cwd: input.cwd, repoPath: input.cwd,
      binary: process.execPath, args: ['-e', script], homeDir: input.home, tmpDir: input.root,
      finalCredentialPolicy: { lockPath: input.lockPath, readFiles: [input.generation], readDirectories: input.codeDirectories },
    });
    const result = JSON.parse(execFileSync(prepared.binary, prepared.args, {
      cwd: input.cwd, env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', HOME: input.home }, encoding: 'utf8', timeout: 10_000,
    }));
    expect(result).toEqual({ generation: 'approved', denied: [true, true, true, true, true, true, true, true] });
    expect(lstatSync(input.lockPath).ino).toBe(before.ino);
    expect(readFileSync(input.generation, 'utf8')).toBe('{"generation":"approved"}');
    expect(readFileSync(join(input.data, '.env.local'), 'utf8')).toContain('synthetic-private-key');
  });

  it('holds the same OS lock against a second parent connection on a zero-byte database', async () => {
    const input = fixture();
    expect(lstatSync(input.lockPath).size).toBe(0);
    const script = `const Database=require(${JSON.stringify(input.sqlite)}); const lock=new Database(${JSON.stringify(input.lockPath)},{timeout:0}); lock.unsafeMode(true); lock.exec('PRAGMA journal_mode=OFF'); lock.exec('BEGIN EXCLUSIVE'); process.stdout.write('locked\\n'); process.stdin.once('data',()=>{lock.close();process.stdin.destroy()});`;
    const prepared = await prepareWorkerSandbox({
      runId: 'credential-lock', profileDir: input.profiles, cwd: input.cwd, repoPath: input.cwd,
      binary: process.execPath, args: ['-e', script], homeDir: input.home, tmpDir: input.root,
      finalCredentialPolicy: { lockPath: input.lockPath, readFiles: [input.generation], readDirectories: input.codeDirectories },
    });
    const child = spawn(prepared.binary, prepared.args, { cwd: input.cwd, env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', HOME: input.home }, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise<void>((resolve, reject) => { child.once('close', code => code === 0 ? resolve() : reject(new Error('Sandbox lock child failed'))); child.once('error', reject); });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('close', () => reject(new Error(stderr))); });
      const contender = new Database(input.lockPath, { timeout: 0 });
      try { expect(() => contender.exec('BEGIN EXCLUSIVE')).toThrow(/locked/); }
      finally { contender.close(); }
    } finally { child.stdin.end('release'); await closed; }
    const next = new Database(input.lockPath, { timeout: 0 });
    try { expect(() => next.exec('BEGIN EXCLUSIVE')).not.toThrow(); }
    finally { next.close(); }
  });

  it('refuses code dependency grants that reopen a protected data subtree', async () => {
    const input = fixture();
    await expect(prepareWorkerSandbox({
      runId: 'broad-policy', profileDir: input.profiles, cwd: input.cwd, repoPath: input.cwd,
      binary: process.execPath, args: [], homeDir: input.home,
      finalCredentialPolicy: { lockPath: input.lockPath, readFiles: [input.generation], readDirectories: [input.data] },
    })).rejects.toThrow();
  });
});
