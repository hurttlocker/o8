import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const sourceRoot = process.cwd();

beforeAll(async () => {
  await execFileAsync(process.execPath, ['cli/esbuild.config.mjs'], { cwd: sourceRoot, timeout: 30_000 });
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(providerExitCode = 0) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'o8-worker-login-cli-'));
  roots.push(root);
  const bin = path.join(root, 'server/bin');
  mkdirSync(bin, { recursive: true });
  for (const file of ['o8.mjs', 'worker-login.mjs']) {
    copyFileSync(path.join(sourceRoot, 'cli/dist', file), path.join(bin, file));
  }
  symlinkSync(path.join(sourceRoot, 'node_modules'), path.join(root, 'server/node_modules'), 'dir');
  const native = path.join(root, 'fixture-cli');
  const record = path.join(root, 'provider-invocation.json');
  const token = `sk-ant-oat01-${'synthetic'.repeat(12)}`;
  writeFileSync(native, [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'if (process.argv.includes("--version")) { console.log("2.1.261"); process.exit(); }',
    `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), masterKeyPresent: Boolean(process.env.O8_MASTER_KEY), apiTokenPresent: Boolean(process.env.O8_API_TOKEN) }));`,
    'process.stdout.write("Browser didn\'t open?".repeat(20000));',
    `setTimeout(() => { console.log(${JSON.stringify(token)}); process.exitCode = ${providerExitCode}; }, 100);`,
  ].join('\n'), { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    NODE_OPTIONS: '',
    O8_DATA_DIR: path.join(root, 'data'),
    CORTEX_IDE_DATA_DIR: path.join(root, 'data'),
    O8_MASTER_KEY: Buffer.alloc(32, 7).toString('base64url'),
    O8_API_TOKEN: 'synthetic-operator-control-token',
    O8_CLAUDE_CODE_BIN: native,
  };
  delete env.O8_WORKER_TOKEN;
  delete env.O8_WORKER_PACKET_ID;
  delete env.O8_SPECTATOR_TOKEN;
  const run = async (args = ['worker', 'login'], extraEnv: Partial<NodeJS.ProcessEnv> = {}) => {
    try {
      const result = await execFileAsync(process.execPath, [path.join(bin, 'o8.mjs'), ...args], {
        cwd: root, env: { ...env, ...extraEnv }, timeout: 15_000, maxBuffer: 32 * 1024,
      });
      return { ...result, code: 0 };
    } catch (error) {
      const result = error as { stdout: string; stderr: string; code: number };
      return { stdout: result.stdout, stderr: result.stderr, code: result.code };
    }
  };
  return { root, bin, token, env, record, run };
}

describe.skipIf(process.platform !== 'darwin')('packaged operator worker login', () => {
  it('uses only packaged files, saves encrypted state, and supplies the existing worker credential reader', async () => {
    const f = fixture();
    expect(existsSync(path.join(f.root, 'scripts'))).toBe(false);
    const result = await f.run();
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ schema: 'o8/cli/worker-login/v1', saved: true, authenticationVerified: false });
    expect(result.stdout + result.stderr).not.toContain(f.token);
    const saved = readFileSync(path.join(f.env.O8_DATA_DIR!, 'native-worker-token.json'), 'utf8');
    expect(saved).not.toContain(f.token);
    expect(JSON.parse(saved)).toMatchObject({ version: 1, ciphertext: expect.any(String), iv: expect.any(String) });
    const invocation = JSON.parse(readFileSync(f.record, 'utf8'));
    expect(invocation).toMatchObject({ args: ['setup-token'], masterKeyPresent: false, apiTokenPresent: false });
    expect(existsSync(invocation.cwd)).toBe(false);

    const { clearMasterKeyCache } = await import('@/lib/db/master-key');
    try {
      vi.stubEnv('O8_DATA_DIR', f.env.O8_DATA_DIR!);
      vi.stubEnv('CORTEX_IDE_DATA_DIR', f.env.CORTEX_IDE_DATA_DIR!);
      vi.stubEnv('O8_MASTER_KEY', f.env.O8_MASTER_KEY!);
      for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']) vi.stubEnv(key, '');
      clearMasterKeyCache();
      const { nativeWorkerTokenEnv } = await import('@/lib/claude-code/worker-token');
      expect(await nativeWorkerTokenEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: f.token });
    } finally {
      vi.unstubAllEnvs();
      clearMasterKeyCache();
    }
  }, 25_000);

  it.each(['O8_WORKER_TOKEN', 'O8_WORKER_PACKET_ID', 'O8_SPECTATOR_TOKEN'])('rejects %s before launching setup', async (key) => {
    const f = fixture();
    const result = await f.run(undefined, { [key]: 'synthetic-scoped-principal' });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('operator_required');
    expect(existsSync(f.record)).toBe(false);
    expect(existsSync(path.join(f.env.O8_DATA_DIR!, 'native-worker-token.json'))).toBe(false);
  });

  it('rejects token arguments without echoing their values', async () => {
    const f = fixture();
    const result = await f.run(['worker', 'login', '--token', f.token]);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(f.token);
    expect(existsSync(f.record)).toBe(false);
  });

  it('does not save or disclose token-shaped output from a failed setup', async () => {
    const f = fixture(1);
    const result = await f.run();
    expect(result.code).toBe(5);
    expect(result.stderr).toContain('worker_login_incomplete');
    expect(result.stdout + result.stderr).not.toContain(f.token);
    expect(existsSync(path.join(f.env.O8_DATA_DIR!, 'native-worker-token.json'))).toBe(false);
    expect(existsSync(JSON.parse(readFileSync(f.record, 'utf8')).cwd)).toBe(false);
  });

  it('reports a missing installed helper without attempting setup', async () => {
    const f = fixture();
    rmSync(path.join(f.bin, 'worker-login.mjs'));
    const result = await f.run();
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('worker_login_unavailable');
    expect(existsSync(f.record)).toBe(false);
    expect(existsSync(path.join(f.env.O8_DATA_DIR!, 'native-worker-token.json'))).toBe(false);
  });

  it('advertises the installed command in help', async () => {
    const f = fixture();
    const result = await f.run(['worker', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('worker login');
  });
});
