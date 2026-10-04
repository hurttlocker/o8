import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenWorkspaceFileResult } from '@/lib/fs/workspace-file';

export interface PiWriteParent {
  path: string;
  dev: number;
  ino: number;
  root: { dev: number; ino: number };
}

/** A child owns a pinned cwd because Node has no portable directory-relative open/rename API. */
export async function commitPiWrite(root: string, path: string, parent: PiWriteParent,
  opened: OpenWorkspaceFileResult | null, before: Buffer | null, content: string, signal: AbortSignal) {
  const directory = await open(parent.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await directory.stat();
    if (!stat.isDirectory() || stat.dev !== parent.dev || stat.ino !== parent.ino) {
      throw new Error('Workspace parent changed before write');
    }
    signal.throwIfAborted();
    const helper = fileURLToPath(new URL('../../../../scripts/pi-sdk/approved-write.mjs', import.meta.url));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [helper], {
        cwd: parent.path, env: { NODE_ENV: 'production' }, signal, timeout: 10_000,
        stdio: ['pipe', 'ignore', 'ignore', directory.fd, opened?.handle.fd ?? 'ignore'],
      });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('Approved file commit refused')));
      child.stdin!.on('error', reject);
      child.stdin!.end(JSON.stringify({ root, parent, name: basename(path),
        target: opened ? { dev: opened.stat.dev, ino: opened.stat.ino } : null,
        before: before?.toString('base64') ?? null, content }));
    });
  } finally { await directory.close(); }
}
