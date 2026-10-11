import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 2_000;
const MAX_PROBE_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const ALLOCATION_BLOCK_BYTES = 4096;

export interface CheckoutStorageMeasurement {
  bytes: number;
  files: number;
}

export type StorageEstimateCommand = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number; windowsHide: boolean },
) => Promise<{ stdout: string }>;

function safeBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Workspace measurement is outside the safe integer range.');
  }
  return value;
}

/** Git checkout writes blobs anew, including on APFS; it shares the object database only. */
export async function measureTrackedCheckout(
  repoPath: string,
  run: StorageEstimateCommand = execFileAsync,
  creationBaseCommit = 'HEAD',
): Promise<CheckoutStorageMeasurement> {
  const { stdout } = await run('git', ['ls-tree', '-r', '-l', '-z', creationBaseCommit], {
    cwd: repoPath, timeout: PROBE_TIMEOUT_MS,
    maxBuffer: MAX_PROBE_OUTPUT_BYTES, windowsHide: true,
  });
  let bytes = 0;
  let files = 0;
  const directories = new Set<string>();
  for (const record of stdout.split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t');
    const metadata = record.slice(0, separator).trim().split(/\s+/);
    const name = record.slice(separator + 1);
    if (separator < 0 || metadata.length !== 4 || !name) {
      throw new Error('Git checkout size returned invalid tree metadata.');
    }
    // Submodule gitlinks are not hydrated by git worktree add.
    if (metadata[1] === 'commit' && metadata[0] === '160000') continue;
    if (metadata[1] !== 'blob' || !/^\d+$/.test(metadata[3])) {
      throw new Error('Git checkout size returned an unsupported tree entry.');
    }
    const logicalBytes = safeBytes(Number(metadata[3]));
    bytes = safeBytes(bytes + Math.ceil(logicalBytes / ALLOCATION_BLOCK_BYTES) * ALLOCATION_BLOCK_BYTES);
    files += 1;
    let directory = path.posix.dirname(name);
    while (directory !== '.') {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return { bytes: safeBytes(bytes + directories.size * ALLOCATION_BLOCK_BYTES), files };
}

/** Measure only a dependency tree that a new install may write, never the whole source/cache. */
export async function measureDependencyTree(
  repoPath: string,
  run: StorageEstimateCommand = execFileAsync,
): Promise<number | null> {
  const target = path.join(repoPath, 'node_modules');
  const entry = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  // A symlink/mount is not proof of a future native allocation or a reusable image recipe.
  if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) return null;
  const { stdout } = await run('du', process.platform === 'darwin'
    ? ['-sk', target]
    : ['-s', '--block-size=1', target], {
    cwd: repoPath, timeout: PROBE_TIMEOUT_MS, maxBuffer: 4096, windowsHide: true,
  });
  const count = stdout.trim().split(/\s+/)[0];
  if (!/^\d+$/.test(count ?? '')) throw new Error('Dependency size returned invalid byte accounting.');
  return safeBytes(Number(count) * (process.platform === 'darwin' ? 1024 : 1));
}

export async function readEstimateInput(
  repoPath: string,
  name: string,
  creationBaseCommit?: string,
): Promise<string | null> {
  if (creationBaseCommit) {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(creationBaseCommit)) {
      throw new Error('Storage estimate requires an immutable creation commit.');
    }
    const options = { cwd: repoPath, timeout: PROBE_TIMEOUT_MS,
      maxBuffer: MAX_INPUT_BYTES, windowsHide: true };
    const tree = await execFileAsync('git', ['ls-tree', '-l', creationBaseCommit, '--', name], options);
    if (!tree.stdout) return null;
    const metadata = tree.stdout.split('\t')[0].trim().split(/\s+/);
    if (metadata[1] !== 'blob' || metadata[0] === '120000' || Number(metadata[3]) > MAX_INPUT_BYTES) {
      throw new Error(`Storage estimate input ${name} is not a bounded regular blob.`);
    }
    return (await execFileAsync('git', ['show', `${creationBaseCommit}:${name}`], options)).stdout;
  }
  const target = path.join(repoPath, name);
  const entry = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!entry) return null;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_INPUT_BYTES) {
    throw new Error(`Storage estimate input ${name} is not a bounded regular file.`);
  }
  return readFile(target, 'utf8');
}
