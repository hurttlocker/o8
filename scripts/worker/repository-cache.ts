import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface CacheInput {
  cacheDir: string;
  repoUrl: string;
  baseSha: string;
  cloneDir: string;
  signal?: AbortSignal;
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('[worker/clone-repo] operation aborted');
}

function identity(input: CacheInput) {
  const key = createHash('sha256').update(input.repoUrl).update('\0').update(input.baseSha).digest('hex');
  return { key, baseSha: input.baseSha, version: 1 };
}

async function directory(target: string): Promise<boolean> {
  try {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid repository cache directory.');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function regularFile(target: string): Promise<string | null> {
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid repository cache metadata.');
    return await readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Copy object bytes only. Never copy refs, configuration, hooks, or alternates. */
async function copyObjects(source: string, destination: string, signal?: AbortSignal): Promise<void> {
  if (!await directory(source)) throw new Error('Repository cache objects are missing.');
  await cp(source, destination, {
    recursive: true,
    filter: async (entry) => {
      aborted(signal);
      const relative = path.relative(source, entry).split(path.sep).join('/');
      const stat = await lstat(entry);
      const allowedDirectory = /^(?:|info|pack|[a-f0-9]{2})$/.test(relative);
      const allowedFile = /^(?:[a-f0-9]{2}\/[a-f0-9]{38}|[a-f0-9]{2}\/[a-f0-9]{62}|pack\/pack-[a-f0-9]{40,64}\.(?:pack|idx|rev|bitmap))$/.test(relative);
      if (stat.isSymbolicLink() || !(stat.isDirectory() ? allowedDirectory : stat.isFile() && allowedFile)) {
        throw new Error('Invalid repository cache object.');
      }
      return true;
    },
  });
}

export async function restoreRepositoryObjects(input: CacheInput): Promise<boolean> {
  aborted(input.signal);
  await mkdir(input.cacheDir, { recursive: true, mode: 0o700 });
  await directory(input.cacheDir);
  const expected = identity(input);
  const entry = path.join(input.cacheDir, expected.key);
  if (!await directory(entry)) return false;
  const manifest = await regularFile(path.join(entry, 'manifest.json'));
  if (!manifest) throw new Error('Repository cache manifest is missing.');
  const value = JSON.parse(manifest) as Partial<typeof expected>;
  if (value.version !== expected.version || value.key !== expected.key || value.baseSha !== expected.baseSha) {
    throw new Error('Repository cache identity does not match the pinned source.');
  }
  const shallow = await regularFile(path.join(entry, 'shallow'));
  if (shallow !== null && shallow.trim() !== input.baseSha) throw new Error('Invalid repository cache shallow boundary.');
  await copyObjects(path.join(entry, 'objects'), path.join(input.cloneDir, '.git', 'objects'), input.signal);
  if (shallow !== null) await writeFile(path.join(input.cloneDir, '.git', 'shallow'), shallow);
  aborted(input.signal);
  return true;
}

export async function preserveRepositoryObjects(input: CacheInput): Promise<void> {
  aborted(input.signal);
  const expected = identity(input);
  const entry = path.join(input.cacheDir, expected.key);
  if (await directory(entry)) return;
  const staging = await mkdtemp(path.join(input.cacheDir, '.building-'));
  try {
    await copyObjects(path.join(input.cloneDir, '.git', 'objects'), path.join(staging, 'objects'), input.signal);
    const shallow = await regularFile(path.join(input.cloneDir, '.git', 'shallow'));
    if (shallow !== null) await writeFile(path.join(staging, 'shallow'), shallow);
    await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(expected)}\n`, { mode: 0o600 });
    aborted(input.signal);
    try { await rename(staging, entry); }
    catch (error) {
      // Concurrent attempts publish complete entries; neither overwrites the winner.
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  } finally { await rm(staging, { recursive: true, force: true }); }
}
