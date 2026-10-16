import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface GitCommandResult {
  stdout: string | Buffer;
  stderr?: string | Buffer;
}

export type WorkspaceScanGitRunner = (args: string[], cwd: string) => Promise<GitCommandResult>;

export const defaultRunGit: WorkspaceScanGitRunner = (args, cwd) => new Promise((resolve, reject) => {
  execFile('git', args, {
    cwd,
    encoding: 'buffer',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10_000,
    windowsHide: true,
  }, (error, stdout, stderr) => {
    if (error) {
      Object.assign(error, { stdout, stderr });
      reject(error);
      return;
    }
    resolve({ stdout, stderr });
  });
});

/** Relocation is only for a clone already verified against its exact quarantine manifest. */
export async function workspaceScanGitContext(
  workspacePath: string,
  originalPath: string | undefined,
  runGit: WorkspaceScanGitRunner,
): Promise<{ args: string[]; managedExcludePath: string | null }> {
  const unchanged = { args: [], managedExcludePath: null };
  let sourcePath = workspacePath;
  if (originalPath) {
    const parent = await realpath(path.dirname(originalPath));
    if (path.dirname(workspacePath) !== parent
      || path.basename(originalPath) === path.basename(workspacePath)) {
      throw new Error('Quarantine Git context requires an exact sibling rename.');
    }
    sourcePath = path.join(parent, path.basename(originalPath));
  }
  let result: GitCommandResult;
  try {
    result = await runGit(['config', '--path', '--get', 'core.excludesFile'], workspacePath);
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return unchanged;
    throw error;
  }
  if (result.stderr?.toString().trim()) throw new Error('Could not read quarantine Git exclude configuration.');
  const relativeExclude = '.git/info/o8-managed-excludes-.git';
  const originalExclude = path.join(sourcePath, relativeExclude);
  // Do not override external, user-selected, or relative exclude configuration.
  if (result.stdout.toString().trim() !== originalExclude) return unchanged;
  for (const relative of ['.git', '.git/info', relativeExclude]) {
    const candidate = path.join(workspacePath, relative);
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink() || await realpath(candidate) !== candidate
      || (relative === relativeExclude ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error('Quarantine managed Git exclude path is not an exact regular entry.');
    }
  }
  // Read the same identity-protected file at its renamed location. Never edit
  // the clone's config or substitute an allowlist for Git's actual ignore rules.
  const managedExcludePath = path.join(workspacePath, relativeExclude);
  return {
    args: originalPath ? ['-c', `core.excludesFile=${managedExcludePath}`] : [],
    managedExcludePath,
  };
}
