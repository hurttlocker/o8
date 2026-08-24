import { lstatSync } from 'node:fs';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_STALE_FIXTURE_AGE_MS,
  fixtureSweepSummary,
  removeFixtureDirectoryIfUnmountedSync,
  removeOwnedTestRunRootSync,
  sweepStaleTestFixtures,
  testRunRetainedAfterTimeout,
  writeTestRunOwner,
} from './test-fixture-lifecycle';

const RUN_TEST_DATA_NAME = /^o8-test-data-run-[A-Za-z0-9]{6}$/;
const WORKER_TEST_DATA_NAME = /^vitest-worker-[a-zA-Z0-9_-]+-\d+$/;

export async function sweepStaleTestDataRoots(
  parentDir: string,
  now = Date.now(),
): Promise<string[]> {
  return (await sweepStaleTestFixtures(parentDir, { now })).removedPaths;
}

export async function createTestRunDataRoot(parentDir: string): Promise<string> {
  await mkdir(parentDir, { recursive: true });
  const runRoot = await mkdtemp(path.join(parentDir, 'o8-test-data-run-'));
  writeTestRunOwner(runRoot);
  return runRoot;
}

export function removeOwnedWorkerDataRoot(runRoot: string, workerRoot: string): boolean {
  const resolvedRunRoot = path.resolve(runRoot);
  const resolvedWorkerRoot = path.resolve(workerRoot);
  if (path.dirname(resolvedWorkerRoot) !== resolvedRunRoot
    || !WORKER_TEST_DATA_NAME.test(path.basename(resolvedWorkerRoot))) {
    throw new Error('Vitest worker data root is outside the owned run parent.');
  }
  let entry;
  try {
    entry = lstatSync(resolvedWorkerRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('Vitest worker data root changed before teardown.');
  }
  return removeFixtureDirectoryIfUnmountedSync(resolvedWorkerRoot);
}

export function removeOwnedTestRunRootUnlessRetained(
  parentDir: string,
  runRoot: string,
): boolean {
  if (testRunRetainedAfterTimeout(runRoot)) return false;
  return removeOwnedTestRunRootSync(parentDir, runRoot);
}

export default async function setupTestRunDataRoot(): Promise<() => Promise<void>> {
  const priorRunRoot = process.env.O8_TEST_RUN_DATA_ROOT;
  const priorTemp = {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  };
  const configuredParent = process.env.CORTEX_IDE_DATA_DIR?.trim();
  const sweepOverride = process.env.O8_TEST_FIXTURE_SWEEP_PARENT?.trim();
  const sweepParents = sweepOverride
    ? [path.resolve(sweepOverride)]
    : [...new Set([os.tmpdir(), configuredParent ? path.resolve(configuredParent) : os.tmpdir()])];
  const thresholdValue = Number(process.env.O8_TEST_FIXTURE_MAX_AGE_MS);
  const thresholdMs = Number.isFinite(thresholdValue) && thresholdValue >= 0
    ? thresholdValue
    : DEFAULT_STALE_FIXTURE_AGE_MS;
  for (const sweepParent of sweepParents) {
    await mkdir(sweepParent, { recursive: true });
    const receipt = await sweepStaleTestFixtures(sweepParent, { thresholdMs });
    console.log(fixtureSweepSummary(receipt));
  }
  const parentDir = configuredParent ? path.resolve(configuredParent) : sweepParents[0]!;
  const runRoot = await createTestRunDataRoot(parentDir);
  process.env.O8_TEST_RUN_DATA_ROOT = runRoot;
  process.env.TMPDIR = runRoot;
  process.env.TMP = runRoot;
  process.env.TEMP = runRoot;
  const exitCleanup = () => {
    removeOwnedTestRunRootUnlessRetained(parentDir, runRoot);
  };
  process.once('exit', exitCleanup);

  return async () => {
    try {
      const canonicalParent = await realpath(parentDir);
      const canonicalRunRoot = await realpath(runRoot).catch(() => null);
      if (canonicalRunRoot && RUN_TEST_DATA_NAME.test(path.basename(canonicalRunRoot))) {
        removeOwnedTestRunRootUnlessRetained(canonicalParent, canonicalRunRoot);
      }
    } finally {
      process.off('exit', exitCleanup);
      if (priorRunRoot === undefined) delete process.env.O8_TEST_RUN_DATA_ROOT;
      else process.env.O8_TEST_RUN_DATA_ROOT = priorRunRoot;
      for (const [name, value] of Object.entries(priorTemp)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };
}
