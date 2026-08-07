import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const originMissingRepos = new Set<string>();

function repoKey(repoPath: string): string {
  return path.resolve(repoPath.trim());
}

export function markRepoOriginMissing(repoPath: string): void {
  originMissingRepos.add(repoKey(repoPath));
}

export function markRepoOriginConfigured(repoPath: string): void {
  originMissingRepos.delete(repoKey(repoPath));
}

export function getRepoOriginConfiguredOverride(repoPath: string): boolean | null {
  return originMissingRepos.has(repoKey(repoPath)) ? false : null;
}

export async function checkRepoOriginConfigured(repoPath: string): Promise<boolean> {
  const key = repoKey(repoPath);
  try {
    const { stdout } = await execFileAsync('git', ['-C', key, 'remote', 'get-url', 'origin'], {
      windowsHide: true,
      timeout: 5_000,
    });
    if (stdout.trim()) {
      originMissingRepos.delete(key);
      return true;
    }
  } catch {
    // Missing origin is a repo-readiness signal, not a readiness probe crash.
  }
  originMissingRepos.add(key);
  return false;
}
