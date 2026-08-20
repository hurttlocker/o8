import { lstatSync, rmSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const STALE_TEST_DATA_AGE_MS = 24 * 60 * 60 * 1_000;
const LEGACY_TEST_DATA_NAME = /^o8-test-data-[A-Za-z0-9]{6}$/;
const RUN_TEST_DATA_NAME = /^o8-test-data-run-[A-Za-z0-9]{6}$/;
const WORKER_TEST_DATA_NAME = /^vitest-worker-[a-zA-Z0-9_-]+-\d+$/;

function isOwnedTestDataName(name: string): boolean {
  return LEGACY_TEST_DATA_NAME.test(name) || RUN_TEST_DATA_NAME.test(name);
}

export async function sweepStaleTestDataRoots(
  parentDir: string,
  now = Date.now(),
): Promise<string[]> {
  const canonicalParent = await realpath(parentDir);
  const entries = await readdir(canonicalParent, { withFileTypes: true });
  const removed: string[] = [];
  for (const entry of entries) {
    if (!isOwnedTestDataName(entry.name)) continue;
    const target = path.join(canonicalParent, entry.name);
    const identity = await lstat(target).catch(() => null);
    if (!identity || identity.isSymbolicLink() || !identity.isDirectory()) continue;
    if (now - identity.mtimeMs < STALE_TEST_DATA_AGE_MS) continue;
    await rm(target, { recursive: true, force: false });
    removed.push(target);
  }
  return removed;
}

export async function createTestRunDataRoot(parentDir: string): Promise<string> {
  await mkdir(parentDir, { recursive: true });
  await sweepStaleTestDataRoots(parentDir);
  return mkdtemp(path.join(parentDir, 'o8-test-data-run-'));
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
  rmSync(resolvedWorkerRoot, { recursive: true, force: false });
  return true;
}

export default async function setupTestRunDataRoot(): Promise<() => Promise<void>> {
  const priorRunRoot = process.env.O8_TEST_RUN_DATA_ROOT;
  const configuredParent = process.env.CORTEX_IDE_DATA_DIR?.trim();
  const parentDir = configuredParent ? path.resolve(configuredParent) : os.tmpdir();
  const runRoot = await createTestRunDataRoot(parentDir);
  process.env.O8_TEST_RUN_DATA_ROOT = runRoot;

  return async () => {
    try {
      const canonicalParent = await realpath(parentDir);
      const canonicalRunRoot = await realpath(runRoot).catch(() => null);
      if (canonicalRunRoot
        && path.dirname(canonicalRunRoot) === canonicalParent
        && RUN_TEST_DATA_NAME.test(path.basename(canonicalRunRoot))) {
        await rm(canonicalRunRoot, { recursive: true, force: false });
      }
    } finally {
      if (priorRunRoot === undefined) delete process.env.O8_TEST_RUN_DATA_ROOT;
      else process.env.O8_TEST_RUN_DATA_ROOT = priorRunRoot;
    }
  };
}
