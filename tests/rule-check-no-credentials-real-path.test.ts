import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'o8-static-rule-check-'));
const entry = resolve('scripts/rule-check.ts');
const loader = createRequire(import.meta.url).resolve('tsx');
const preload = join(root, 'deny-credentials.cjs');
const denied = join(root, 'credential-access');
writeFileSync(preload, `
const Module = require('node:module');
const fs = require('node:fs');
const original = Module._load;
Module._load = function(request, parent, isMain) {
  if (/[/\\\\]db[/\\\\](master-key|index)(\\.|$)/.test(request)) {
    fs.writeFileSync(${JSON.stringify(denied)}, 'credential module loaded');
    throw new Error('Static check attempted to load application credentials');
  }
  return original.call(this, request, parent, isMain);
};
const cp = require('node:child_process');
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = cp[name];
  cp[name] = function(command, ...args) {
    if (/(^|[/\\\\])security$/.test(String(command))) {
      fs.writeFileSync(${JSON.stringify(denied)}, 'keychain command invoked');
      throw new Error('Static check attempted a Keychain command');
    }
    return original.call(this, command, ...args);
  };
  Object.setPrototypeOf(cp[name], original);
}
require('node:module').syncBuiltinESMExports();
`);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('standalone rule-check credential isolation', () => {
  it.each(['clean', 'untracked-violation', 'tracked-violation'])('keeps findings without credential modules (%s)', (scenario) => {
    const violation = scenario !== 'clean';
    const repo = join(root, scenario);
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-q', '--allow-empty', '-m', 'baseline']);
    if (scenario === 'tracked-violation') {
      writeFileSync(join(repo, 'fixture.tsx'), 'export const fixture = 1;\n');
      execFileSync('git', ['-C', repo, 'add', 'fixture.tsx']);
      execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '-q', '-m', 'fixture']);
    }
    writeFileSync(join(repo, 'fixture.tsx'), violation
      ? 'export const Fixture = () => <div className="example" />;\n'
      : 'export const fixture = 1;\n');
    rmSync(denied, { force: true });
    const state = join(repo, 'application-state');
    const result = spawnSync(process.execPath, ['--require', preload, '--import', loader, entry, '--base=HEAD'], {
      cwd: repo,
      env: { ...process.env, TSX_TSCONFIG_PATH: resolve('tsconfig.json'),
        O8_DATA_DIR: state, CORTEX_IDE_DATA_DIR: state, O8_MASTER_KEY: '' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(existsSync(denied), result.stdout + result.stderr).toBe(false);
    expect(result.status, result.stdout + result.stderr).toBe(violation ? 1 : 0);
    expect(result.stdout + result.stderr).toContain(violation ? 'className' : 'zero violations');
    if (!violation) expect(result.stdout).toContain('scanned 1 file(s)');
    expect(existsSync(state)).toBe(false);
  });
});
