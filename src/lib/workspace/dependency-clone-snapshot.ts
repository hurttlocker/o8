import { lstat, open } from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';

export type DependencyCloneSnapshot = Array<[string, string]>;

function stamp(entry: BigIntStats): string {
  return [entry.dev, entry.ino, entry.mode, entry.size, entry.mtimeNs, entry.ctimeNs].join(':');
}

export class DependencyCloneSourceChanged extends Error {}

/** Identity and mutation receipts for recipe metadata and selected native files. */
export function dependencyCloneSnapshot(workspace: string) {
  const entries = new Map<string, string>();
  const remember = (relative: string, entry: BigIntStats) => {
    const value = stamp(entry);
    if (entries.has(relative) && entries.get(relative) !== value) throw new DependencyCloneSourceChanged();
    entries.set(relative, value);
  };
  return {
    async record(relative: string) {
      const entry = await lstat(path.join(workspace, relative), { bigint: true });
      remember(relative, entry);
      return entry;
    },
    async read(relative: string): Promise<string> {
      const before = await lstat(path.join(workspace, relative), { bigint: true });
      if (!before.isFile() || before.isSymbolicLink()) throw new DependencyCloneSourceChanged();
      remember(relative, before);
      const handle = await open(path.join(workspace, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        remember(relative, await handle.stat({ bigint: true }));
        const bytes = await handle.readFile('utf8');
        remember(relative, await handle.stat({ bigint: true }));
        return bytes;
      } finally { await handle.close(); }
    },
    receipt: () => [...entries] as DependencyCloneSnapshot,
  };
}

export async function dependencyCloneSnapshotMatches(workspace: string, snapshot: DependencyCloneSnapshot): Promise<boolean> {
  for (const [relative, expected] of snapshot) {
    try {
      if (stamp(await lstat(path.join(workspace, relative), { bigint: true })) !== expected) return false;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
  }
  return true;
}
