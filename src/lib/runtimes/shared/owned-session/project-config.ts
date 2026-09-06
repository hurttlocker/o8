import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

/** A linked checkout can load hooks from its backing project's config file. */
export async function backingProjectConfigPaths(
  gitPaths: string[],
  worktreeRoot: string,
  protectedRoots: string[],
): Promise<string[]> {
  const commonDir = gitPaths.at(-1);
  // A bare or separately located Git directory does not identify a checkout.
  if (!commonDir || path.basename(commonDir) !== '.git') return [];
  const projectRoot = await realpath(path.dirname(commonDir));
  if (projectRoot === worktreeRoot) return [];
  if (protectedRoots.includes(projectRoot)) {
    throw new Error('A backing project cannot re-open a protected root configuration.');
  }
  const config = path.join(projectRoot, '.codex', 'config.toml');
  const entry = await lstat(config).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!entry) return [];
  // Do not turn a repository symlink into a grant on an operator's config or
  // credential store. Only this regular file at its canonical path is eligible.
  if (!entry.isFile() || await realpath(config) !== config) {
    throw new Error('Backing project configuration must be a regular, non-aliased file.');
  }
  return [config];
}
