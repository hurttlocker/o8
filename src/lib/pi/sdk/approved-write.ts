import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
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
  kept?: string[];
  committed?: boolean;
  captures?: { name: string; from: string }[];
  /** Captures reported after the run's last kept report. */
  movedSinceKept?: { name: string; from: string }[];
}
interface HelperRun extends HelperProgress { code: number | null }

const RECOVERY_ATTEMPTS = 3;
const HIDDEN = /^\.o8-pi-(write|q)-[0-9a-f-]{36}$/;

function readProgress(line: string, progress: HelperProgress) {
  let message: unknown;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message !== 'object') return;
  const { kept, committed, capture, from } = message as Record<string, unknown>;
  if (typeof kept === 'string' && HIDDEN.test(kept)) {
    if (!progress.kept?.includes(kept)) (progress.kept ??= []).push(kept);
    progress.movedSinceKept = [];
  }
  if (committed === true) progress.committed = true;
  if (typeof capture === 'string' && /^\.o8-pi-q-[0-9a-f-]{36}$/.test(capture) && typeof from === 'string') {
    (progress.captures ??= []).push({ name: capture, from });
    (progress.movedSinceKept ??= []).push({ name: capture, from });
  }
}

/**
 * SIGTERM asks the helper to stop at its next safe point, where it cleans up
 * itself. A helper that cannot respond within the grace period is killed.
 * A null exit code means a signal ended the helper, whoever sent it.
 */
function runHelper(helper: string, stdio: [number, number | 'ignore', number], request: object,
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
 * with no-replace and exchange renames Node does not expose. The stage file is
 * created here and held open across every run, so each run, recovery included,
 * can wipe it through a descriptor whatever happens to its names or mode.
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
    const stageName = `.o8-pi-write-${randomUUID()}`;
    // The helper refuses unless this file is the one at the stage name in the
    // pinned parent, so a parent swapped since the check above publishes nothing.
    const stage = await open(join(parent.path, stageName),
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const stageStat = await stage.stat();
      const request = { root, parent, name: basename(path),
        target: opened ? { dev: opened.stat.dev, ino: opened.stat.ino } : null,
        before: before?.toString('base64') ?? null, content, stage: stageName,
        stageId: { dev: stageStat.dev, ino: stageStat.ino } };
      const stdio: [number, number | 'ignore', number] = [directory.fd, opened?.handle.fd ?? 'ignore', stage.fd];
      const progress: { committed: boolean; captures: { name: string; from: string }[]; kept: string[] } =
        { committed: false, captures: [], kept: [] };
      // Each run inherits everything earlier runs reported, including a commit
      // point a recovery run reached. A run that finished reports where kept
      // entries are now; a run that was killed may have captured one after its
      // last report, so those capture names become places to look too.
      const absorb = (run: HelperRun) => {
        progress.committed ||= run.committed ?? false;
        progress.captures.push(...run.captures ?? []);
        if (run.code !== null) progress.kept = [...run.kept ?? []];
        else {
          progress.kept = [...new Set([...progress.kept, ...run.kept ?? []])];
          for (const capture of run.movedSinceKept ?? []) {
            if (progress.kept.includes(capture.from)) progress.kept.push(capture.name);
          }
        }
      };
      let result: HelperRun | undefined;
      let unrecovered = false;
      try {
        result = await runHelper(helper, stdio, { mode: 'commit', ...request }, signal, timeouts);
        absorb(result);
      } catch { /* the helper could not start; the stage below is still ours */ }
      for (let attempt = 0; result?.code === null && attempt < RECOVERY_ATTEMPTS; attempt++) {
        try {
          result = await runHelper(helper, stdio, { mode: 'recover', ...request,
            committed: progress.committed, captures: progress.captures }, undefined, timeouts);
        } catch { unrecovered = true; break; }
        absorb(result);
      }
      if (result?.code === null) unrecovered = true;
      // The commit receipt is the commit point: once reported, the approved
      // bytes were published, even if cleanup did not finish.
      if (result?.code === 0 || progress.committed) return;
      // No helper will run again. Wipe the uncommitted stage through the
      // descriptor held, then drop its name if the helper did not.
      await stage.truncate(0).catch(() => {});
      const leftover = await lstat(join(parent.path, stageName)).catch(() => null);
      if (leftover && leftover.dev === stageStat.dev && leftover.ino === stageStat.ino) {
        await unlink(join(parent.path, stageName)).catch(() => {});
      }
      // A kept original is reported even when the run was aborted. Places to
      // look that are empty now are dropped, unless none is left.
      const candidates = progress.kept.length ? progress.kept : unrecovered && opened ? [stageName] : [];
      const present = (await Promise.all(candidates.map(name => lstat(join(parent.path, name)).then(() => name, () => null))))
        .filter((name): name is string => name !== null);
      const kept = present.length ? present : candidates;
      if (kept.length === 1) {
        throw new Error(`Approved file commit refused; the previous file was kept as ${kept[0]}`);
      }
      if (kept.length) throw new Error(`Approved file commit refused; moved entries were kept as ${kept.join(', ')}`);
      signal.throwIfAborted();
      throw new Error('Approved file commit refused');
    } finally { await stage.close(); }
  } finally { await directory.close(); }
}
