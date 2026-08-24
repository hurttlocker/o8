import {
  existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  removeOwnedTestRunRootUnlessRetained,
  removeOwnedWorkerDataRoot,
  sweepStaleTestDataRoots,
} from './global-test-data-dir';
import {
  retainTestRunAfterTimeout,
  TEST_RUN_OWNER_FILE,
  writeTestRunOwner,
} from './test-fixture-lifecycle';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('test data root cleanup', () => {
  it('removes stale o8 fixture roots without following links or deleting recent runs', async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'o8-test-sweep-parent-'));
    const external = mkdtempSync(path.join(os.tmpdir(), 'o8-test-sweep-external-'));
    roots.push(parent, external);
    const staleLegacy = path.join(parent, 'o8-test-data-Ab12Cd');
    const staleRun = path.join(parent, 'o8-test-data-run-Ef34Gh');
    const recentRun = path.join(parent, 'o8-test-data-run-Ij56Kl');
    const foreign = path.join(parent, 'o8-test-data-foreign-name');
    const linked = path.join(parent, 'o8-test-data-Mn78Op');
    const now = Date.now();
    for (const target of [staleLegacy, staleRun, recentRun, foreign]) mkdirSync(target);
    for (const target of [staleLegacy, staleRun, recentRun, foreign]) writeTestRunOwner(target);
    writeFileSync(path.join(staleRun, TEST_RUN_OWNER_FILE), JSON.stringify({
      pid: Number.MAX_SAFE_INTEGER,
      startedAt: new Date(now - (25 * 60 * 60 * 1_000)).toISOString(),
    }));
    symlinkSync(external, linked);
    const stale = new Date(now - (25 * 60 * 60 * 1_000));
    for (const target of [staleLegacy, staleRun, foreign, linked]) utimesSync(target, stale, stale);

    const removed = await sweepStaleTestDataRoots(parent, now);
    expect(removed.sort()).toEqual([
      path.join(realpathSync(parent), path.basename(staleLegacy)),
      path.join(realpathSync(parent), path.basename(staleRun)),
      path.join(realpathSync(parent), path.basename(foreign)),
    ].sort());

    expect(existsSync(staleLegacy)).toBe(false);
    expect(existsSync(staleRun)).toBe(false);
    expect(existsSync(recentRun)).toBe(true);
    expect(existsSync(foreign)).toBe(false);
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

  it('retains a timed-out run root until the stale-fixture sweep owns cleanup', () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'o8-test-retain-parent-'));
    const runRoot = mkdtempSync(path.join(parent, 'o8-test-data-run-'));
    roots.push(parent);
    writeTestRunOwner(runRoot);
    retainTestRunAfterTimeout(runRoot);

    expect(removeOwnedTestRunRootUnlessRetained(parent, runRoot)).toBe(false);
    expect(existsSync(runRoot)).toBe(true);
  });
});
