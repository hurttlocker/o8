import { copyFile, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const owned = new Set<string>();
export async function cleanupUsageDatabaseSnapshots() {
  await Promise.all([...owned].map(async directory => { await rm(directory, { recursive: true, force: true }); owned.delete(directory); }));
}
async function signature(path: string, optional = false) {
  try {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile()) throw new Error('Usage database must be a regular file.');
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** SQLite readOnly may still create WAL sidecars. Open a stable, private copy instead of touching the provider store. */
export async function openUsageDatabaseSnapshot(path: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const directory = await mkdtemp(join(tmpdir(), 'o8-usage-db-')); owned.add(directory);
    const target = join(directory, 'snapshot.db'); let database: DatabaseSync | undefined;
    try {
      const before = await Promise.all([signature(path), signature(`${path}-wal`, true)]);
      await copyFile(path, target);
      if (before[1]) await copyFile(`${path}-wal`, `${target}-wal`);
      const after = await Promise.all([signature(path), signature(`${path}-wal`, true)]);
      if (before.some((value, index) => value !== after[index])) throw new Error('Usage database changed during capture.');
      database = new DatabaseSync(target, { readOnly: true });
      const opened = database;
      return { database: opened, close: async () => {
        try { opened.close(); } finally { await rm(directory, { recursive: true, force: true }); owned.delete(directory); }
      } };
    } catch (error) {
      database?.close(); await rm(directory, { recursive: true, force: true }); owned.delete(directory);
      if (attempt === 2) throw error;
    }
  }
  throw new Error('Usage database could not be captured.');
}
