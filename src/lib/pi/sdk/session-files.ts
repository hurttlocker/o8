import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** The most recently written Pi session file under `dir`, which a new process resumes. */
export async function newestPiSessionFile(dir: string): Promise<string | undefined> {
  let newest: { path: string; mtime: number } | undefined;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const path = join(entry.parentPath, entry.name);
    const mtime = (await stat(path).catch(() => null))?.mtimeMs ?? 0;
    if (!newest || mtime > newest.mtime) newest = { path, mtime };
  }
  return newest?.path;
}
