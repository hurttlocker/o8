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

/** What the helper reported before it exited: enough for a recovery run to act on. */
interface HelperProgress { stageId?: { dev: number; ino: number }; backup?: string; kept?: string }
interface HelperRun extends HelperProgress { code: number | null }

const RECOVERY_ATTEMPTS = 3;

function readProgress(line: string, progress: HelperProgress) {
  let message: unknown;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message !== 'object') return;
  const { stage, backup, kept } = message as Record<string, unknown>;
  if (stage && typeof stage === 'object' && Number.isSafeInteger((stage as { dev?: unknown }).dev)
    && Number.isSafeInteger((stage as { ino?: unknown }).ino)) {
    progress.stageId = { dev: (stage as { dev: number }).dev, ino: (stage as { ino: number }).ino };
  }
  if (typeof backup === 'string' && /^\.o8-pi-backup-[0-9a-f-]{36}$/.test(backup)) progress.backup = backup;
  if (typeof kept === 'string' && /^\.o8-pi-backup-[0-9a-f-]{36}$/.test(kept)) progress.kept = kept;
}

/**
 * SIGTERM asks the helper to stop at its next safe point, where it cleans up
 * itself. A helper that cannot respond within the grace period is killed.
 * A null exit code means a signal ended the helper, whoever sent it.
 */
function runHelper(helper: string, cwd: string, stdio: [number, number | 'ignore'], request: object,
  signal: AbortSignal | undefined, { timeoutMs = 10_000, killGraceMs = 2_000 }: PiWriteTimeouts) {
  return new Promise<HelperRun>((resolve, reject) => {
    const child = spawn(process.execPath, [helper], {
      cwd, env: { NODE_ENV: 'production' }, stdio: ['pipe', 'pipe', 'ignore', ...stdio],
    });
    const progress: HelperProgress = {};
    let pending = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) readProgress(line, progress);
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
    // 'close' waits for stdout to drain, so every report is read.
    child.once('close', code => { done(); readProgress(pending, progress); resolve({ code, ...progress }); });
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
    const request = { root, parent, name: basename(path),
      target: opened ? { dev: opened.stat.dev, ino: opened.stat.ino } : null,
      before: before?.toString('base64') ?? null, content, stage: `.o8-pi-write-${randomUUID()}` };
    const stdio: [number, number | 'ignore'] = [directory.fd, opened?.handle.fd ?? 'ignore'];
    let result = await runHelper(helper, parent.path, stdio, { mode: 'commit', ...request }, signal, timeouts);
    const progress: HelperProgress = { ...result };
    // Recovery acts only on the stage identity the commit reported; without it
    // nothing of the commit's can be told apart from other files.
    for (let attempt = 0; result.code === null && progress.stageId && attempt < RECOVERY_ATTEMPTS; attempt++) {
      result = await runHelper(helper, parent.path, stdio, { mode: 'recover', ...request,
        stageId: progress.stageId, backup: progress.backup ?? null }, undefined, timeouts);
      progress.kept = result.kept ?? progress.kept;
    }
    if (result.code === 0) return;
    signal.throwIfAborted();
    throw new Error(progress.kept
      ? `Approved file commit refused; the previous file was kept as ${progress.kept}`
      : 'Approved file commit refused');
  } finally { await directory.close(); }
}
