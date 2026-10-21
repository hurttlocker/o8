import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const dirs: string[] = [];
const children: ChildProcess[] = [];
beforeAll(() => { execFileSync(process.execPath, ['cli/esbuild.config.mjs'], { cwd: root, stdio: 'pipe' }); });
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    child.kill('SIGKILL'); await exited;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('supervised restart review-mode admission', () => {
  it.each(['manual', 'invalid-mode'])('refuses %s before signaling an automatic supervisor', async (requested) => {
    const dir = mkdtempSync(join(tmpdir(), 'o8-review-mode-')); dirs.push(dir);
    mkdirSync(join(dir, 'server/bin'), { recursive: true });
    const cli = join(dir, 'server/bin/o8.mjs');
    copyFileSync(join(root, 'cli/dist/o8.mjs'), cli);
    // Even an erroneous fallback to start can only execute these inert fixtures.
    writeFileSync(join(dir, 'server/server.js'), 'process.exit(2);');
    writeFileSync(join(dir, 'server/ws-server.mjs'), 'process.exit(2);');
    const signalFile = join(dir, 'received-sighup');
    const child = spawn(process.execPath, ['-e', `
      process.on('SIGHUP',()=>require('node:fs').writeFileSync(${JSON.stringify(signalFile)},'1'));
      process.send('ready'); setInterval(()=>{},1000);
    `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.push(child);
    await new Promise<void>((done) => child.once('message', () => done()));
    const state = JSON.stringify({ schema: 'o8/serve-state/v1', pid: child.pid, supervisorPid: child.pid,
      generation: 'fixture-generation', reviewMode: 'automatic', children: [], status: 'ready' });
    writeFileSync(join(dir, 'serve.pid'), String(child.pid));
    writeFileSync(join(dir, 'serve-state.json'), state);
    const result = await new Promise<{ code: number; output: string }>((done) => {
      execFile(process.execPath, [cli, 'serve', 'restart'], {
        cwd: dir, env: { ...process.env, O8_DATA_DIR: dir, CORTEX_IDE_DATA_DIR: dir, O8_REVIEW_MODE: requested }, timeout: 2_000,
      }, (error, stdout, stderr) => done({ code: error ? Number(error.code) || 1 : 0, output: stdout + stderr }));
    });
    expect(result.code).not.toBe(0);
    expect(existsSync(signalFile), 'refusal must precede SIGHUP').toBe(false);
    expect(result.output).toContain(requested === 'manual' ? 'serve_review_mode_change_requires_stop' : 'O8_REVIEW_MODE');
    expect(readFileSync(join(dir, 'serve-state.json'), 'utf8')).toBe(state);
    expect(readFileSync(join(dir, 'serve.pid'), 'utf8')).toBe(String(child.pid));
  });
});
