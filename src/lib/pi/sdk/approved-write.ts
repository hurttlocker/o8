import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import type { OpenWorkspaceFileResult } from '@/lib/fs/workspace-file';
import { piWriteHelperPath } from './scripts';

export interface PiWriteParent {
  path: string;
  dev: number;
  ino: number;
  root: { dev: number; ino: number };
}
export interface PiWriteTimeouts { timeoutMs?: number; killGraceMs?: number }

/** What the helper reported before it exited: enough for a recovery run to act on. */
interface HelperProgress {
  stageId?: { dev: number; ino: number };
  publishedId?: { dev: number; ino: number };
  kept?: string;
  committed?: boolean;
  captures?: { name: string; from: string }[];
}
interface HelperRun extends HelperProgress { code: number | null }

const RECOVERY_ATTEMPTS = 3;
const HIDDEN = /^\.o8-pi-(write|q)-[0-9a-f-]{36}$/;

function identity(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const { dev, ino } = value as { dev?: unknown; ino?: unknown };
  return Number.isSafeInteger(dev) && Number.isSafeInteger(ino) ? { dev: dev as number, ino: ino as number } : undefined;
}

function readProgress(line: string, progress: HelperProgress) {
  let message: unknown;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message !== 'object') return;
  const { stage, published, kept, committed, capture, from } = message as Record<string, unknown>;
  progress.stageId = identity(stage) ?? progress.stageId;
  progress.publishedId = identity(published) ?? progress.publishedId;
  if (typeof kept === 'string' && HIDDEN.test(kept)) progress.kept = kept;
  if (committed === true) progress.committed = true;
  if (typeof capture === 'string' && /^\.o8-pi-q-[0-9a-f-]{36}$/.test(capture) && typeof from === 'string') {
    (progress.captures ??= []).push({ name: capture, from });
  }
}

/**
 * SIGTERM asks the helper to stop at its next safe point, where it cleans up
 * itself. A helper that cannot respond within the grace period is killed.
 * A null exit code means a signal ended the helper, whoever sent it.
 */
function runHelper(helper: string, stdio: [number, number | 'ignore'], request: object,
  signal: AbortSignal | undefined, { timeoutMs = 10_000, killGraceMs = 2_000 }: PiWriteTimeouts) {
  return new Promise<HelperRun>((resolve, reject) => {
    // The helper works only through the inherited descriptors and reads no cwd or environment.
    const child = spawn(helper, [], { cwd: '/', env: { NODE_ENV: 'production' }, stdio: ['pipe', 'pipe', 'ignore', ...stdio] });
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

/**
 * The native helper (#3289) publishes relative to the pinned parent descriptor,
 * with no-replace and exchange renames Node does not expose.
 */
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
    const helper = piWriteHelperPath();
    const request = { root, parent, name: basename(path),
      target: opened ? { dev: opened.stat.dev, ino: opened.stat.ino } : null,
      before: before?.toString('base64') ?? null, content, stage: `.o8-pi-write-${randomUUID()}` };
    const stdio: [number, number | 'ignore'] = [directory.fd, opened?.handle.fd ?? 'ignore'];
    let result = await runHelper(helper, stdio, { mode: 'commit', ...request }, signal, timeouts);
    const progress: HelperProgress = { ...result, captures: [...result.captures ?? []] };
    // Recovery acts only on the stage identity the commit reported; without it
    // nothing of the commit's can be told apart from other files. Each run
    // inherits everything earlier runs reported, including a commit point a
    // recovery run reached.
    for (let attempt = 0; result.code === null && progress.stageId && attempt < RECOVERY_ATTEMPTS; attempt++) {
      result = await runHelper(helper, stdio, { mode: 'recover', ...request,
        stageId: progress.stageId, publishedId: progress.publishedId ?? null, committed: progress.committed ?? false,
        captures: progress.captures }, undefined, timeouts);
      progress.kept = result.kept ?? progress.kept;
      progress.committed ||= result.committed;
      progress.captures!.push(...result.captures ?? []);
    }
    if (result.code === 0) return;
    // A kept original is reported even when the run was aborted.
    if (progress.kept) throw new Error(`Approved file commit refused; the previous file was kept as ${progress.kept}`);
    signal.throwIfAborted();
    throw new Error('Approved file commit refused');
  } finally { await directory.close(); }
}
