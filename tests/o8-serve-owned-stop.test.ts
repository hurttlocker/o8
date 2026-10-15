import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'o8-owned-stop-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'server/bin'), { recursive: true });
  copyFileSync(cli, join(dir, 'server/bin/o8.mjs'));
  writeFileSync(join(dir, 'server/server.js'), 'process.exit(2);');
  writeFileSync(join(dir, 'server/ws-server.mjs'), 'process.exit(2);');
  return dir;
}

async function fixture(respawn = false, race: 'successor' | 'overlap' | null = null) {
  const dir = makeDir();
  const child = spawn(process.execPath, ['-e', `
    const {spawn} = require('node:child_process');
    function launch() {
      const leaf = spawn(process.execPath, ['-e', ${JSON.stringify(race === 'overlap' ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)" : 'setInterval(()=>{},1000)')}], {detached:true,stdio:'ignore'});
      process.send({leaf:leaf.pid});
      if (${respawn}) leaf.once('exit', launch);
    }
    launch();
    process.on('SIGTERM',()=>{
      const fs=require('node:fs');
      fs.rmSync(${JSON.stringify(join(dir, 'serve.pid'))},{force:true});
      fs.rmSync(${JSON.stringify(join(dir, 'serve-state.json'))},{force:true});
      fs.writeFileSync(${JSON.stringify(join(dir, 'term-observed'))}, '1');
      if (${race === 'successor'}) {
        const next = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'successor.json'))},'utf8'));
        fs.writeFileSync(${JSON.stringify(join(dir, 'serve.pid'))},String(next.pid));
        fs.writeFileSync(${JSON.stringify(join(dir, 'serve-state.json'))},JSON.stringify(next));
      }
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
function stop(dir: string, command = 'stop'): Promise<{code:number;output:string}> {
  return new Promise((done) => {
    execFile(process.execPath, [join(dir, 'server/bin/o8.mjs'), 'serve', ...(command ? [command] : [])], {
      cwd: dir, env: { ...process.env, O8_DATA_DIR: dir, CORTEX_IDE_DATA_DIR: dir }, encoding: 'utf8', timeout: 20_000,
    }, (error, stdout, stderr) => done({ code: error ? Number(error.code) || 1 : 0, output: stdout + stderr }));
  });
}
afterEach(async () => {
  for (const dir of dirs) {
    try {
      const state = JSON.parse(readFileSync(join(dir, 'serve-state.json'), 'utf8'));
      for (const pid of [state.pid, ...(state.children ?? []).map((child: {pid:number}) => child.pid)]) if (pid) pids.add(pid);
    } catch {}
    for (const file of ['serve.pid', 'leaf.pid']) {
      try { const pid = Number(readFileSync(join(dir, file), 'utf8')); if (pid > 0) pids.add(pid); } catch {}
    }
  }
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

  it.each([false, true])('does not overwrite or delete a successor generation (same PID: %s)', async (samePid) => {
    const f = await fixture(false, 'successor');
    const next = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    children.push(next); pids.add(next.pid!);
    const successor = { ...f.state, pid: samePid ? f.state.pid : next.pid, generation: 'successor-generation', startedAt: samePid ? f.state.startedAt : 'successor' };
    writeFileSync(join(f.dir, 'successor.json'), JSON.stringify(successor));
    const result = await stop(f.dir);
    expect(result.code, 'stale stop must refuse successor cleanup').not.toBe(0);
    expect(readFileSync(join(f.dir, 'serve.pid'), 'utf8')).toBe(String(successor.pid));
    expect(JSON.parse(readFileSync(join(f.dir, 'serve-state.json'), 'utf8'))).toEqual(successor);
    expect(alive(next.pid!)).toBe(true);
  }, 25_000);

  it('excludes a competing start and stop until the widest retained census is settled', async () => {
    const f = await fixture(false, 'overlap');
    const first = stop(f.dir);
    const deadline = Date.now() + 8_000;
    while (!existsSync(join(f.dir, 'term-observed')) && Date.now() < deadline) await pause(20);
    expect(existsSync(join(f.dir, 'term-observed'))).toBe(true);
    const second = await stop(f.dir);
    const start = await stop(f.dir, '');
    expect(second.output).toContain('serve_operation_busy');
    expect(start.output).toContain('serve_operation_busy');
    expect((await first).code).toBe(0);
    const receipt = JSON.parse(readFileSync(join(f.dir, 'serve-stop.json'), 'utf8'));
    expect(receipt.processes.map((claim: {pid:number}) => claim.pid)).toContain(f.leaf);
    expect(alive(f.leaf)).toBe(false);
  }, 25_000);

  it('retains the full census when a real daemon receives stop during child shutdown', async () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'server/server.js'), `
      const {spawn}=require('node:child_process'); const fs=require('node:fs');
      const leaf=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
      fs.writeFileSync(${JSON.stringify(join(dir, 'leaf.pid'))},String(leaf.pid));
      require('node:http').createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({product:'o8'}));}).listen(Number(process.env.PORT),'127.0.0.1');
      process.on('SIGTERM',()=>{});
    `);
    writeFileSync(join(dir, 'server/ws-server.mjs'), `import net from 'node:net';net.createServer().listen(Number(process.env.WS_PORT),'127.0.0.1');`);
    const started = await stop(dir, '');
    expect(started.code, started.output).toBe(0);
    const before = JSON.parse(readFileSync(join(dir, 'serve-state.json'), 'utf8'));
    const leaf = Number(readFileSync(join(dir, 'leaf.pid'), 'utf8')); pids.add(leaf);
    const expected = [before.pid, leaf, ...before.children.map((child: {pid:number}) => child.pid)];
    const stopped = await stop(dir);
    expect(stopped.code, stopped.output).toBe(0);
    const receipt = JSON.parse(readFileSync(join(dir, 'serve-stop.json'), 'utf8'));
    expect(receipt.processes.map((claim: {pid:number}) => claim.pid)).toEqual(expect.arrayContaining(expected));
    expect(receipt.confirmedDead).toBe(true);
    expect(existsSync(join(dir, 'serve.pid'))).toBe(false);
    expect(existsSync(join(dir, 'serve-state.json'))).toBe(false);
    expect(existsSync(join(dir, 'serve-operation.lock'))).toBe(false);
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
