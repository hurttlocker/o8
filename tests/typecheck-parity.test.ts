import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

function check(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'o8-checker-parity-'));
  try {
    writeFileSync(join(root, 'index.ts'), source);
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, types: [], lib: ['esnext'] },
      files: ['index.ts'],
    }));
    return spawnSync(process.execPath, ['scripts/typecheck-parity.mjs', '--project', join(root, 'tsconfig.json')], {
      encoding: 'utf8', timeout: 30_000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('runs only tsc 5.8.2 and tsrs on a clean project', () => {
  const result = check('export const value: number = 1;');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('tsc: 0 diagnostics, exit 0');
  expect(result.stdout).not.toContain('native:');
  expect(result.stdout).toContain('tsrs: 0 diagnostics, exit 0');
  expect(result.stdout).toContain('PASS: diagnostic sets match (0 diagnostics).');
});

it('compares diagnostics independently of differing failure exit codes', () => {
  const result = check('export const value: number = "wrong";');
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('PASS: diagnostic sets match (1 diagnostics).');
  expect(result.stdout.match(/1 diagnostics, exit [12]/g)).toHaveLength(2);
});

it('rejects an actual library diagnostic difference between compiler versions', () => {
  const result = check('new Map<string, number>().getOrInsert("key", 1);');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('FAIL: diagnostic sets differ.');
  expect(result.stderr).toContain('missing:');
  expect(result.stderr).toContain('getOrInsert');
});

it('keeps the default npx tsc entry point on TypeScript 5.8.2', () => {
  const result = spawnSync(process.execPath, ['node_modules/.bin/tsc', '--version'], { encoding: 'utf8' });
  // On Windows npm creates a .cmd shim instead of the Unix symlink.
  if (process.platform === 'win32') {
    const windows = spawnSync('npx', ['--no-install', 'tsc', '--version'], { encoding: 'utf8', shell: true });
    expect(windows.status, windows.stderr).toBe(0);
    expect(windows.stdout.trim()).toBe('Version 5.8.2');
  } else {
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('Version 5.8.2');
  }
});
