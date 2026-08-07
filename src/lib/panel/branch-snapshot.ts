import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const STALE_THRESHOLD_DAYS = 3;
const MAX_CONCURRENCY = 8;

interface BranchInfo {
  name: string;
  current: boolean;
  lastCommitAge: string;
  lastCommitMessage: string;
  lastCommitUnix: number;
  isWorktree: boolean;
  worktreePath?: string;
  ahead: number;
  behind: number;
  additions: number;
  deletions: number;
  isStale: boolean;
  staleDays?: number;
  diskSize?: string;
}

interface SnapshotEntry {
  branches: BranchInfo[];
  generation: string;
}

const snapshots = new Map<string, SnapshotEntry>();
const metrics = new Map<string, Pick<BranchInfo, 'ahead' | 'behind' | 'additions' | 'deletions'>>();
const refreshes = new Map<string, Promise<void>>();

async function git(repoPath: string, args: string[], timeout = 5000): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    windowsHide: true,
    encoding: 'utf-8', timeout,
  });
  return stdout.trim();
}

async function gitOrEmpty(repoPath: string, args: string[], timeout?: number): Promise<string> {
  try { return await git(repoPath, args, timeout); } catch { return ''; }
}

async function generationFor(repoPath: string): Promise<string | null> {
  const [head, refs] = await Promise.all([
    gitOrEmpty(repoPath, ['rev-parse', '--verify', 'HEAD'], 2000),
    gitOrEmpty(repoPath, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/'], 3000),
  ]);
  return head ? `${head}\n${refs}` : null;
}

function parseShortstat(raw: string): Pick<BranchInfo, 'additions' | 'deletions'> {
  return {
    additions: Number(raw.match(/(\d+)\s+insertion/)?.[1] ?? 0),
    deletions: Number(raw.match(/(\d+)\s+deletion/)?.[1] ?? 0),
  };
}

async function runJobs<T>(jobs: Array<() => Promise<T>>): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await jobs[index]();
    }
  }));
  return results;
}

async function diskSize(targetPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('du', ['-sh', targetPath], {
      windowsHide: true,
      encoding: 'utf-8', timeout: 3000,
    });
    return stdout.trim().split('\t')[0] || undefined;
  } catch { return undefined; }
}

async function defaultBranchFor(repoPath: string): Promise<string> {
  const symbolic = await gitOrEmpty(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 2000);
  if (symbolic.startsWith('origin/')) return symbolic.slice('origin/'.length);
  return await gitOrEmpty(repoPath, ['rev-parse', '--verify', 'master'], 2000) ? 'master' : 'main';
}

async function computeSnapshot(repoPath: string): Promise<BranchInfo[]> {
  const [defaultBranch, branchRaw, wtRaw] = await Promise.all([
    defaultBranchFor(repoPath),
    git(repoPath, ['for-each-ref', '--sort=-committerdate', 'refs/heads/', '--format=%(refname:short)|||%(objectname)|||%(committerdate:relative)|||%(subject)|||%(HEAD)|||%(committerdate:unix)']),
    gitOrEmpty(repoPath, ['worktree', 'list', '--porcelain']),
  ]);
  const worktrees = new Map<string, string>();
  let currentPath = '';
  for (const line of wtRaw.split('\n')) {
    if (line.startsWith('worktree ')) currentPath = line.slice(9);
    if (line.startsWith('branch refs/heads/')) worktrees.set(line.slice(18), currentPath);
  }
  const baseTip = await gitOrEmpty(repoPath, ['rev-parse', '--verify', defaultBranch], 2000);
  const now = Date.now();
  const parsed = branchRaw.split('\n').filter(Boolean).map((line) => {
    const [name, tip, age, message, head, unixStr] = line.split('|||');
    const trimmedName = name?.trim();
    if (!trimmedName) return null;
    const worktreePath = worktrees.get(trimmedName);
    const isCurrent = head?.trim() === '*';
    const isWorktree = Boolean(worktreePath && worktreePath !== repoPath);
    if ((!isCurrent && !isWorktree && trimmedName.startsWith('worktree/')) || trimmedName.startsWith('worktree-agent-')) return null;
    if (!isCurrent && isWorktree && worktreePath?.includes('/.claude/worktrees/agent-')) return null;
    return { name: trimmedName, tip: tip?.trim() ?? '', age: age?.trim() ?? '', message: message?.trim() ?? '', isCurrent, isWorktree, worktreePath, commitUnix: Number(unixStr?.trim() ?? 0) * 1000 };
  }).filter((branch): branch is NonNullable<typeof branch> => branch !== null);
  const branches = await runJobs(parsed.map((branch) => async (): Promise<BranchInfo | null> => {
    if (!branch.isCurrent && !branch.isWorktree && branch.name !== defaultBranch) {
      try { await git(repoPath, ['diff', '--quiet', `${defaultBranch}..${branch.name}`], 3000); return null; } catch { /* branch has a diff */ }
    }
    const upstreamTip = await gitOrEmpty(repoPath, ['rev-parse', '--verify', `origin/${branch.name}`], 2000);
    const metricKey = `${repoPath}\0${branch.tip}\0${baseTip}\0${upstreamTip}`;
    let metric = metrics.get(metricKey);
    if (!metric) {
      const [aheadBehind, shortstat] = await Promise.all([
        upstreamTip ? gitOrEmpty(repoPath, ['rev-list', '--left-right', '--count', `origin/${branch.name}...${branch.name}`], 3000) : '',
        branch.name === defaultBranch ? '' : gitOrEmpty(repoPath, ['diff', '--shortstat', `${defaultBranch}...${branch.name}`], 3000),
      ]);
      const [behind = 0, ahead = 0] = aheadBehind.split('\t').map(Number);
      metric = { ahead, behind, ...parseShortstat(shortstat) };
      metrics.set(metricKey, metric);
    }
    const days = Math.floor((now - branch.commitUnix) / 86_400_000);
    return { name: branch.name, current: branch.isCurrent, lastCommitAge: branch.age, lastCommitMessage: branch.message.split('\n')[0], lastCommitUnix: branch.commitUnix, isWorktree: branch.isWorktree, worktreePath: branch.isWorktree ? branch.worktreePath : undefined, ...metric, isStale: !branch.isCurrent && days >= STALE_THRESHOLD_DAYS, staleDays: !branch.isCurrent && days >= STALE_THRESHOLD_DAYS ? days : undefined, diskSize: branch.isWorktree && branch.worktreePath ? await diskSize(branch.worktreePath) : undefined };
  }));
  return branches.filter((branch): branch is BranchInfo => branch !== null).sort((a, b) => b.lastCommitUnix - a.lastCommitUnix);
}

async function refresh(repoPath: string): Promise<void> {
  const generation = await generationFor(repoPath);
  if (!generation || snapshots.get(repoPath)?.generation === generation) return;
  snapshots.set(repoPath, { branches: await computeSnapshot(repoPath), generation });
}

export function getCachedBranchSnapshot(repoPath: string): BranchInfo[] | null {
  return snapshots.get(repoPath)?.branches ?? null;
}

export async function getBranchSnapshot(repoPath: string): Promise<BranchInfo[] | null> {
  const cached = getCachedBranchSnapshot(repoPath);
  if (cached) return cached;
  await refresh(repoPath);
  return snapshots.get(repoPath)?.branches ?? null;
}

export function refreshBranchSnapshot(repoPath: string): Promise<void> {
  const current = refreshes.get(repoPath);
  if (current) return current;
  const refreshPromise = refresh(repoPath).catch(() => {}).finally(() => refreshes.delete(repoPath));
  refreshes.set(repoPath, refreshPromise);
  return refreshPromise;
}
