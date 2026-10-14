import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { probeMetadataLockProcessIdentity } from '../src/lib/worktree/metadata-lock-process-identity';

const root = resolve(import.meta.dirname, '..');
const cli = process.env.O8_TEST_SERVE_CLI || join(root, 'cli/dist/o8.mjs');
beforeAll(() => {
  if (!process.env.O8_TEST_SERVE_CLI) execFileSync(process.execPath, ['cli/esbuild.config.mjs'], { cwd: root, stdio: 'pipe' });
});
const children: ChildProcess[] = [];
const pids = new Set<number>();
const dirs: string[] = [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function fixture(respawn = false) {
  const dir = mkdtempSync(join(tmpdir(), 'o8-owned-stop-'));
  dirs.push(dir);
  const child = spawn(process.execPath, ['-e', `
    const {spawn} = require('node:child_process');
    function launch() {
      const leaf = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {detached:true,stdio:'ignore'});
      process.send({leaf:leaf.pid});
      if (${respawn}) leaf.once('exit', launch);
    }
    launch();
    process.on('SIGTERM',()=>{
      const fs=require('node:fs');
      fs.rmSync(${JSON.stringify(join(dir, 'serve.pid'))},{force:true});
      fs.rmSync(${JSON.stringify(join(dir, 'serve-state.json'))},{force:true});
      process.exit(0);
    });
    setInterval(()=>{},1000);
  `], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.push(child);
  const leaf = await new Promise<number>((done) => child.once('message', (m) => done((m as {leaf:number}).leaf)));
  pids.add(leaf); pids.add(child.pid!);
  const identity = await probeMetadataLockProcessIdentity(child.pid!);
  expect(identity.state).toBe('live');
  if (identity.state !== 'live') throw new Error('Missing fixture identity');
  const state = { schema: 'o8/serve-state/v1', pid: child.pid, pgid: child.pid,
    processIdentity: identity.identity, mode: 'development', root, children: [], status: 'ready',
    startedAt: new Date().toISOString(), apiPort: 1, wsPort: 2 };
  writeFileSync(join(dir, 'serve.pid'), String(child.pid));
  writeFileSync(join(dir, 'serve-state.json'), JSON.stringify(state));
  return { dir, child, leaf, state };
}
function stop(dir: string): Promise<{code:number;output:string}> {
  return new Promise((done) => {
    execFile(process.execPath, [cli, 'serve', 'stop'], {
      cwd: root, env: { ...process.env, O8_DATA_DIR: dir, CORTEX_IDE_DATA_DIR: dir }, encoding: 'utf8', timeout: 20_000,
    }, (error, stdout, stderr) => done({ code: error ? Number(error.code) || 1 : 0, output: stdout + stderr }));
  });
}
afterEach(async () => {
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  for (const child of children) { if (child.exitCode === null) child.kill('SIGKILL'); }
  await pause(100);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  pids.clear(); children.length = 0; dirs.length = 0;
});

describe.skipIf(process.platform === 'win32')('serve stop process ownership entry point', () => {
  it('stops detached descendants and preserves an unrelated process', async () => {
    const f = await fixture();
    const outsider = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    children.push(outsider); pids.add(outsider.pid!);
    const result = await stop(f.dir);
    await pause(100);
    expect(result.code, result.output).toBe(0);
    expect(alive(f.leaf), 'detached descendant must be absent').toBe(false);
    expect(alive(outsider.pid!)).toBe(true);
    const receipt = JSON.parse(readFileSync(join(f.dir, 'serve-stop.json'), 'utf8'));
    expect(receipt.confirmedDead).toBe(true);
    expect(receipt.processes.map((p: {pid:number}) => p.pid)).toContain(f.leaf);
  }, 25_000);

  it('stops a supervising ancestor before it can replace a terminated child', async () => {
    const f = await fixture(true);
    const descendants = new Set([f.leaf]);
    f.child.on('message', (message) => {
      const pid = (message as { leaf: number }).leaf;
      descendants.add(pid); pids.add(pid);
    });
    const result = await stop(f.dir);
    expect(result.code, result.output).toBe(0);
    await pause(100);
    expect([...descendants].filter(alive), 'no replacement child may survive').toEqual([]);
  }, 25_000);

  it('refuses to certify an already-dead ancestor without a retained descendant census', async () => {
    const f = await fixture();
    f.child.kill('SIGKILL');
    await new Promise<void>((done) => f.child.once('exit', () => done()));
    const result = await stop(f.dir);
    expect(result.code).not.toBe(0);
    expect(alive(f.leaf)).toBe(true);
    expect(JSON.parse(readFileSync(join(f.dir, 'serve-state.json'), 'utf8')).pid).toBe(f.state.pid);
  }, 25_000);

  it('refuses a stale birth identity and preserves the process and evidence', async () => {
    const f = await fixture();
    f.state.processIdentity.startId += '-stale';
    writeFileSync(join(f.dir, 'serve-state.json'), JSON.stringify(f.state));
    const result = await stop(f.dir);
    expect(result.code).not.toBe(0);
    expect(alive(f.child.pid!)).toBe(true);
    expect(alive(f.leaf)).toBe(true);
    expect(JSON.parse(readFileSync(join(f.dir, 'serve-state.json'), 'utf8')).processIdentity).toEqual(f.state.processIdentity);
  }, 25_000);
});
