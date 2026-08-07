import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 512 * 1024;

export interface BranchMergeProbeInput {
  repoPath: string;
  branch: string;
  base: string;
}

export interface BranchMergeProbeResult {
  merged: boolean;
  mergeCommit: string | null;
  ahead: number;
}

function normalizeRef(value: string, label: string): string {
  const ref = value.trim();
  if (!ref) {
    throw new Error(`${label} is required`);
  }
  if (
    ref.startsWith('-')
    || ref.includes('..')
    || ref.includes('@{')
    || /[\s~^:?*[\\\]\x00-\x1f]/.test(ref)
  ) {
    throw new Error(`Invalid ${label}: ${ref}`);
  }
  return ref;
}

async function gitValue(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    windowsHide: true,
    cwd: repoPath,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout.trim();
}

async function readAheadCount(repoPath: string, baseRef: string, branch: string): Promise<number> {
  const output = await gitValue(repoPath, ['rev-list', '--count', `${baseRef}..${branch}`]);
  const ahead = Number.parseInt(output, 10);
  if (!Number.isFinite(ahead) || ahead < 0) {
    throw new Error(`Invalid ahead count for ${baseRef}..${branch}: ${output}`);
  }
  return ahead;
}

async function readShortSha(repoPath: string, ref: string): Promise<string | null> {
  const output = await gitValue(repoPath, ['rev-parse', '--short', ref]);
  return output || null;
}

export async function probeBranchMerged(input: BranchMergeProbeInput): Promise<BranchMergeProbeResult> {
  const repoPath = input.repoPath.trim();
  if (!repoPath) {
    throw new Error('repoPath is required');
  }

  const branch = normalizeRef(input.branch, 'branch');
  const base = normalizeRef(input.base, 'base');
  const baseRef = `origin/${base}`;
  const ahead = await readAheadCount(repoPath, baseRef, branch);

  return {
    merged: ahead === 0,
    mergeCommit: ahead === 0 ? await readShortSha(repoPath, baseRef) : null,
    ahead,
  };
}
