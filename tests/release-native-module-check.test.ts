import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const releaseScript = join(process.cwd(), 'scripts', 'release.mjs');
const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-release-native-modules-'));
  roots.push(root);
  return root;
}

function stubModule(root: string, moduleName: string) {
  const moduleRoot = join(root, 'node_modules', moduleName);
  mkdirSync(moduleRoot, { recursive: true });
  writeFileSync(join(moduleRoot, 'index.js'), `module.exports = ${JSON.stringify(moduleName)};\n`);
  return join(moduleRoot, 'index.js');
}

function runCheck(root: string) {
  return spawnSync(process.execPath, [releaseScript, '--verify-checkout-native-modules', root], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
  });
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('post-ship checkout native module check', () => {
  it('prints both resolved paths when the native modules load', () => {
    const root = fixture();
    const sqlitePath = stubModule(root, 'better-sqlite3');
    const ptyPath = stubModule(root, 'node-pty');

    const result = runCheck(root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`better-sqlite3 resolved to ${realpathSync(sqlitePath)}`);
    expect(result.stdout).toContain(`node-pty resolved to ${realpathSync(ptyPath)}`);
  });

  it('fails with the missing module name', () => {
    const root = fixture();
    stubModule(root, 'node-pty');

    const result = runCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('checkout native module better-sqlite3 failed to resolve or load');
    expect(result.stderr).toContain('checkout native module verification failed');
    expect(result.stdout).toContain('checkout native module node-pty resolved to');
  });
});
