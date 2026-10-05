import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import type { OpenWorkspaceFileResult } from '@/lib/fs/workspace-file';
import { piSdkScriptPath } from './scripts';

export interface PiWriteParent {
  path: string;
  dev: number;
  ino: number;
  root: { dev: number; ino: number };
}
export interface PiWriteTimeouts { timeoutMs?: number; killGraceMs?: number }

interface HelperRun { code: number | null }

/**
 * SIGTERM asks the helper to stop at its next safe point, where it cleans up
 * itself. A helper that cannot respond within the grace period is killed.
 * A null exit code means a signal ended the helper, whoever sent it.
 */
function runHelper(helper: string, cwd: string, stdio: [number, number | 'ignore'], request: object,
  signal: AbortSignal | undefined, { timeoutMs = 10_000, killGraceMs = 2_000 }: PiWriteTimeouts) {
  return new Promise<HelperRun>((resolve, reject) => {
    const child = spawn(process.execPath, [helper], {
      cwd, env: { NODE_ENV: 'production' }, stdio: ['pipe', 'ignore', 'ignore', ...stdio],
    });
    let kill: NodeJS.Timeout | undefined;
    const stop = () => {
      if (kill || child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      kill = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    };
    const timer = setTimeout(stop, timeoutMs);
    const done = () => { clearTimeout(timer); clearTimeout(kill); signal?.removeEventListener('abort', stop); };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.once('error', error => { done(); reject(error); });
    child.once('exit', code => { done(); resolve({ code }); });
    // The exit code reports the outcome, including a helper that exits before reading.
    child.stdin!.on('error', () => {});
    child.stdin!.end(JSON.stringify(request));
  });
}

/** A child owns a pinned cwd because Node has no portable directory-relative open/rename API. */
export async function commitPiWrite(root: string, path: string, parent: PiWriteParent,
  opened: OpenWorkspaceFileResult | null, before: Buffer | null, content: string, signal: AbortSignal,
  timeouts: PiWriteTimeouts = {}) {
  if (process.platform === 'win32') throw new Error('Approved Pi writes are not supported on Windows');
  const directory = await open(parent.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await directory.stat();
    if (!stat.isDirectory() || stat.dev !== parent.dev || stat.ino !== parent.ino) {
      throw new Error('Workspace parent changed before write');
    }
    signal.throwIfAborted();
    const helper = piSdkScriptPath('approved-write.mjs');
    // Host-chosen names let a recovery run find the stage and backup after a kill.
    const id = randomUUID();
    const request = { root, parent, name: basename(path),
      target: opened ? { dev: opened.stat.dev, ino: opened.stat.ino } : null,
      before: before?.toString('base64') ?? null, content,
      stage: `.o8-pi-write-${id}`, backup: `.o8-pi-backup-${id}` };
    const stdio: [number, number | 'ignore'] = [directory.fd, opened?.handle.fd ?? 'ignore'];
    let result = await runHelper(helper, parent.path, stdio, { mode: 'commit', ...request }, signal, timeouts);
    if (result.code === null) {
      result = await runHelper(helper, parent.path, stdio, { mode: 'recover', ...request }, undefined, timeouts);
    }
    if (result.code === 0) return;
    signal.throwIfAborted();
    throw new Error('Approved file commit refused');
  } finally { await directory.close(); }
}
