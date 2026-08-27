import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const scriptPath = join(process.cwd(), 'scripts', 'bust-stale-patch-cache.mjs');

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-patch-cache-bust-'));
  const patchesDir = join(root, 'patches');
  const cacheDir = join(root, '.next', 'cache');
  const webpackDir = join(cacheDir, 'webpack');
  mkdirSync(patchesDir, { recursive: true });
  mkdirSync(webpackDir, { recursive: true });
  writeFileSync(join(patchesDir, 'dependency.patch'), 'patch');
  writeFileSync(join(webpackDir, 'entry.bin'), 'stale cache');
  roots.push(root);
  return { root, patchesDir, cacheDir };
}

describe('patch cache invalidation', () => {
  it('clears stale cache contents without removing the cache root', () => {
    const { root, patchesDir, cacheDir } = fixture();
    const old = new Date('2026-01-01T00:00:00.000Z');
    const fresh = new Date('2026-01-02T00:00:00.000Z');
    utimesSync(cacheDir, old, old);
    utimesSync(join(patchesDir, 'dependency.patch'), fresh, fresh);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('clearing webpack cache');
    expect(existsSync(cacheDir)).toBe(true);
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  it('preserves cache contents when patches are not newer', () => {
    const { root, patchesDir, cacheDir } = fixture();
    const old = new Date('2026-01-01T00:00:00.000Z');
    const fresh = new Date('2026-01-02T00:00:00.000Z');
    utimesSync(join(patchesDir, 'dependency.patch'), old, old);
    utimesSync(cacheDir, fresh, fresh);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(existsSync(join(cacheDir, 'webpack', 'entry.bin'))).toBe(true);
  });
});
