/**
 * Windows-safe directory removal — lock-retry + quarantine (#1673 audit item 8).
 *
 * `fs.rm(dir, {recursive:true, force:true})` fails with EBUSY/EPERM/EACCES on
 * Windows whenever any process (a running node, git, Defender scan) holds an
 * open handle inside the dir. macOS/Linux can unlink open files so this class
 * of error never fires there — this module makes cleanup resilient to it on
 * any platform without changing macOS/Linux behavior (the retries just never
 * trigger there).
 *
 * Strategy: retry rm with backoff; if the dir still can't be removed, rename
 * it out of the way into a quarantine directory so the slot is freed and the
 * (still-locked) bytes can be reclaimed later once the lock clears.
 */
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export type RemoveDirResult =
  | { status: 'removed' }
  | { status: 'quarantined'; quarantinedTo: string }
  | { status: 'failed' };

const LOCK_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
const DEFAULT_DELAYS_MS = [250, 1000, 3000];

function isLockClassError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return typeof code === 'string' && LOCK_ERROR_CODES.has(code);
}

function isEnoent(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ENOENT';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RemoveLockedDirOptions {
  quarantineBase: string;
  delaysMs?: number[];
  logPrefix?: string;
  rmImpl?: typeof rm;
  renameImpl?: typeof rename;
  mkdirImpl?: typeof mkdir;
}

export async function removeLockedDir(
  target: string,
  opts: RemoveLockedDirOptions,
): Promise<RemoveDirResult> {
  const delays = opts.delaysMs ?? DEFAULT_DELAYS_MS;
  const logPrefix = opts.logPrefix ?? 'remove-locked-dir';
  const rmFn = opts.rmImpl ?? rm;
  const renameFn = opts.renameImpl ?? rename;
  const mkdirFn = opts.mkdirImpl ?? mkdir;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await rmFn(target, { recursive: true, force: true });
      return { status: 'removed' };
    } catch (err) {
      if (isEnoent(err)) return { status: 'removed' };
      if (!isLockClassError(err)) throw err;
      lastErr = err;
      const delay = delays[attempt];
      if (delay === undefined) break;
      console.warn(`[${logPrefix}] rm locked (${(err as { code?: string }).code}) for ${target} — retrying in ${delay}ms`);
      await sleep(delay);
    }
  }

  console.warn(`[${logPrefix}] rm still locked after ${delays.length} retries for ${target} — quarantining (${(lastErr as { code?: string } | undefined)?.code ?? 'unknown'})`);

  try {
    await mkdirFn(opts.quarantineBase, { recursive: true });
    const quarantinedTo = path.join(opts.quarantineBase, `${path.basename(target)}-${Date.now()}`);
    await renameFn(target, quarantinedTo);
    console.warn(`[${logPrefix}] quarantined ${target} → ${quarantinedTo}`);
    return { status: 'quarantined', quarantinedTo };
  } catch (renameErr) {
    console.error(`[${logPrefix}] quarantine failed for ${target}: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`);
    return { status: 'failed' };
  }
}
