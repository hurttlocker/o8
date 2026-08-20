import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { removeOwnedWorkerDataRoot, sweepStaleTestDataRoots } from './global-test-data-dir';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('test data root cleanup', () => {
  it('removes only stale owned roots without following links or deleting recent runs', async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'o8-test-sweep-parent-'));
    const external = mkdtempSync(path.join(os.tmpdir(), 'o8-test-sweep-external-'));
    roots.push(parent, external);
    const staleLegacy = path.join(parent, 'o8-test-data-Ab12Cd');
    const staleRun = path.join(parent, 'o8-test-data-run-Ef34Gh');
    const recentRun = path.join(parent, 'o8-test-data-run-Ij56Kl');
    const foreign = path.join(parent, 'o8-test-data-foreign-name');
    const linked = path.join(parent, 'o8-test-data-Mn78Op');
    for (const target of [staleLegacy, staleRun, recentRun, foreign]) mkdirSync(target);
    symlinkSync(external, linked);
    const now = Date.now();
    const stale = new Date(now - (25 * 60 * 60 * 1_000));
    for (const target of [staleLegacy, staleRun, foreign, linked]) utimesSync(target, stale, stale);

    await expect(sweepStaleTestDataRoots(parent, now)).resolves.toEqual([
      path.join(realpathSync(parent), path.basename(staleLegacy)),
      path.join(realpathSync(parent), path.basename(staleRun)),
    ]);

    expect(existsSync(staleLegacy)).toBe(false);
    expect(existsSync(staleRun)).toBe(false);
    expect(existsSync(recentRun)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(linked)).toBe(true);
    expect(existsSync(external)).toBe(true);
  });

  it('removes only an exact worker child from its run parent', () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'o8-test-data-run-'));
    const worker = path.join(parent, 'vitest-worker-1-12345');
    const sibling = path.join(parent, 'keep-me');
    roots.push(parent);
    mkdirSync(worker);
    mkdirSync(sibling);

    expect(removeOwnedWorkerDataRoot(parent, worker)).toBe(true);
    expect(existsSync(worker)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
    expect(() => removeOwnedWorkerDataRoot(parent, sibling)).toThrow(
      'outside the owned run parent',
    );
  });
});
