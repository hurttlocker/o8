import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * A negative result proves that an existing folder has no discoverable Git
 * context. Keep ambiguous cases on the normal Git path, including explicit
 * environment overrides, bare repositories, and unreadable metadata.
 *
 * Check only ancestor markers, never workspace contents. Do not cache absence:
 * a repository initialized after an idle poll must be found by the next poll.
 */
export async function mayHaveGitRepositoryContext(folder: string): Promise<boolean> {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) return true;

  let current: string;
  try {
    current = await realpath(path.resolve(folder));
  } catch {
    return true;
  }

  for (let depth = 0; depth < 128; depth += 1) {
    // A .git marker may be a directory, pointer file, or symlink. A bare
    // repository has HEAD directly in its root; Git validates positive hints.
    for (const marker of ['.git', 'HEAD']) {
      try {
        await lstat(path.join(current, marker));
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') return true;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }

  // An unusually deep path is uncertain, not proof that discovery can be skipped.
  return true;
}
