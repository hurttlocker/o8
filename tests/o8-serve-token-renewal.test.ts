import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'cli/dist/o8.mjs');
const dirs: string[] = [];
beforeAll(() => { execFileSync(process.execPath, ['cli/esbuild.config.mjs'], { cwd: root, stdio: 'pipe' }); });
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'o8-token-renew-')); dirs.push(dir);
  writeFileSync(join(dir, 'serve-instance-id'), 'fixture-instance');
  writeFileSync(join(dir, 'ws-token'), 'fixture-original-token', { mode: 0o600 });
  writeFileSync(join(dir, 'operator-defaults.json'), '{"reviewContinuation":true}');
  return dir;
}
function renew(dir: string): Promise<{code:number;output:string}> {
  return new Promise((done) => {
    execFile(process.execPath, [cli, 'serve', 'renew-token'], {
      cwd: root, env: { ...process.env, O8_DATA_DIR: dir, CORTEX_IDE_DATA_DIR: dir, O8_WORKER_TOKEN: '' }, timeout: 10_000,
    }, (error, stdout, stderr) => done({ code: error ? Number(error.code) || 1 : 0, output: stdout + stderr }));
  });
}
it('renews only the stopped profile token without printing credentials or changing defaults', async () => {
  const dir = fixture();
  const result = await renew(dir);
  expect(result.code, result.output).toBe(0);
  const token = readFileSync(join(dir, 'ws-token'), 'utf8');
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(result.output).not.toContain(token);
  expect(result.output).not.toContain('fixture-original-token');
  expect(JSON.parse(result.output)).toMatchObject({ renewed: true });
  expect(readFileSync(join(dir, 'operator-defaults.json'), 'utf8')).toBe('{"reviewContinuation":true}');
  if (process.platform !== 'win32') expect(statSync(join(dir, 'ws-token')).mode & 0o777).toBe(0o600);
  expect(existsSync(join(dir, 'serve.pid'))).toBe(false);
});
it.each(['serve.pid', 'serve-state.json'])('refuses retained ownership in %s without changing the token', async (file) => {
  const dir = fixture();
  writeFileSync(join(dir, file), file === 'serve.pid' ? String(process.pid) : '{"shutdownProcesses":[{"pid":999999}]}');
  expect((await renew(dir)).code).not.toBe(0);
  expect(readFileSync(join(dir, 'ws-token'), 'utf8')).toBe('fixture-original-token');
  expect(existsSync(join(dir, file))).toBe(true);
});
it('refuses a listening runtime even without a serve owner file', async () => {
  const dir = fixture(); const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    writeFileSync(join(dir, 'api-port'), String(address.port));
    expect((await renew(dir)).code).not.toBe(0);
    expect(readFileSync(join(dir, 'ws-token'), 'utf8')).toBe('fixture-original-token');
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});
