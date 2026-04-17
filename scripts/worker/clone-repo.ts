import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const EXEC_OPTIONS = { maxBuffer: 10 * 1024 * 1024, timeout: 120_000 };

export interface CloneOptions {
  repoUrl: string;
  baseRef: string;
  remoteBranch: string;
  workDir: string;
}

async function ensureGhAuthIfNeeded(repoUrl: string) {
  if (!/github\.com/i.test(repoUrl)) return;
  try {
    await execFileAsync('gh', ['auth', 'status'], EXEC_OPTIONS);
  } catch {
    if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
      throw new Error(
        '[worker/clone-repo] gh auth status failed and neither GITHUB_TOKEN nor GH_TOKEN is set. Run `gh auth login` or export a token before starting the worker.',
      );
    }
  }
}

async function pathExists(target: string) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function cloneRepoForRun(opts: CloneOptions): Promise<string> {
  await ensureGhAuthIfNeeded(opts.repoUrl);
  await mkdir(opts.workDir, { recursive: true });

  const cloneTarget = path.join(opts.workDir, 'repo');
  if (await pathExists(cloneTarget)) {
    throw new Error(`[worker/clone-repo] workDir already has a repo: ${cloneTarget}. Pass a fresh --workspace-dir run slot.`);
  }

  await execFileAsync('git', ['clone', opts.repoUrl, cloneTarget], EXEC_OPTIONS);
  await execFileAsync('git', ['checkout', opts.baseRef], { ...EXEC_OPTIONS, cwd: cloneTarget });
  await execFileAsync('git', ['checkout', '-b', opts.remoteBranch], { ...EXEC_OPTIONS, cwd: cloneTarget });

  return cloneTarget;
}

export async function pushRemoteBranch(cloneDir: string, remoteBranch: string): Promise<string> {
  await execFileAsync('git', ['push', '-u', 'origin', remoteBranch], { ...EXEC_OPTIONS, cwd: cloneDir });
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { ...EXEC_OPTIONS, cwd: cloneDir });
  return stdout.trim();
}
