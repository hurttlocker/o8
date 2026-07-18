import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { cleanupLaneWorktree } from '@/lib/lane/worktree-cleanup';
import { getWorktreeManager } from '@/lib/worktree/launch';
import type { Lane } from '@/lib/lane/types';
import type { ExistingBranchPolicy, LoadedIssue } from './types';

const execFileAsync = promisify(execFile);

export interface MissionBranchCandidate {
  issue: LoadedIssue;
  branchTarget: string;
}

export interface MissionBranchDecision {
  issueNumber: number;
  branchTarget: string;
  action: 'none' | 'continued' | 'reset';
  reason: 'no_prior_attempt' | 'operator_continue' | 'operator_reset' | 'spec_changed' | 'stale_prior_attempt';
  lanesArchived: number;
  worktreePruned: boolean;
  branchDeleted: boolean;
}

export interface IssueBranchCleanupResult {
  lanesArchived: number;
  worktreePruned: boolean;
  branchDeleted: boolean;
  branchExisted: boolean;
}

interface ExistingBranchProbe {
  activeLanes: Lane[];
  staleLanes: Lane[];
  hasBranch: boolean;
  hasWorktree: boolean;
}

function normalizeRepoPath(repoPath: string) {
  return repoPath.trim().replace(/\/+$/, '');
}

function normalizeIssueText(value: string | undefined) {
  return (value ?? '').replace(/\r\n/g, '\n').trim();
}

function issueSpec(issue: LoadedIssue) {
  return `${normalizeIssueText(issue.title)}\n\n${normalizeIssueText(issue.body)}`;
}

function sameRepo(left: string, right: string) {
  return normalizeRepoPath(left) === normalizeRepoPath(right);
}

function isTerminalLane(lane: Lane) {
  return lane.status === 'archived' || lane.status === 'completed';
}

function isDispatchBranch(branch: string) {
  return branch.startsWith('issue/') || branch.startsWith('inline/');
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function localBranchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: repoPath,
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

function parseWorktreeList(stdout: string) {
  const entries: Array<{ path: string; branch?: string }> = [];
  let current: { path: string; branch?: string } | null = null;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim() };
      entries.push(current);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '').trim();
    }
  }

  return entries;
}

async function gitWorktreesForBranch(repoPath: string, branch: string) {
  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
      timeout: 10_000,
    });
    return parseWorktreeList(stdout).filter((entry) => entry.branch === branch);
  } catch {
    return [];
  }
}

async function pruneGitWorktreeMetadata(repoPath: string) {
  await execFileAsync('git', ['worktree', 'prune'], {
    cwd: repoPath,
    timeout: 10_000,
  }).catch(() => {});
}

async function removeWorktreePath(repoPath: string, worktreePath: string, laneId: string) {
  if (!worktreePath.trim() || sameRepo(repoPath, worktreePath)) {
    return false;
  }

  return cleanupLaneWorktree({
    id: laneId,
    repoPath,
    worktreePath,
  });
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function cleanupWorktreesForBranch(
  repoPath: string,
  branch: string,
  worktreePaths: string[],
) {
  let removed = 0;
  const seenPaths = new Set<string>();
  const normalizedRepo = normalizeRepoPath(repoPath);
  const manager = getWorktreeManager(repoPath);

  try {
    const managed = await manager.list();
    for (const worktree of managed) {
      const path = normalizeRepoPath(worktree.path);
      const explicitlyListed = worktreePaths.some((candidate) => normalizeRepoPath(candidate) === path);
      if (path === normalizedRepo || (worktree.branch !== branch && !explicitlyListed)) continue;
      seenPaths.add(path);
      try {
        await manager.cleanup(worktree.id, { force: true, deleteBranch: true });
        if (!(await pathExists(worktree.path))) {
          removed += 1;
        }
      } catch (error) {
        console.warn(`[mission-branch-cleanup] Manager cleanup failed for ${worktree.id}: ${formatError(error)}`);
      }
    }
  } catch (error) {
    console.warn(`[mission-branch-cleanup] Could not list managed worktrees for ${branch}: ${formatError(error)}`);
  }

  const directWorktrees = await gitWorktreesForBranch(repoPath, branch);
  for (const worktree of directWorktrees) {
    const path = normalizeRepoPath(worktree.path);
    if (path === normalizedRepo || seenPaths.has(path)) continue;
    if (await removeWorktreePath(repoPath, worktree.path, `branch:${branch}`)) {
      removed += 1;
      seenPaths.add(path);
    }
  }

  for (const worktreePath of worktreePaths) {
    const path = normalizeRepoPath(worktreePath);
    if (!path || path === normalizedRepo || seenPaths.has(path)) continue;
    if (await removeWorktreePath(repoPath, worktreePath, `branch:${branch}`)) {
      removed += 1;
      seenPaths.add(path);
    }
  }

  await pruneGitWorktreeMetadata(repoPath);
  return removed;
}

async function deleteLocalBranch(repoPath: string, branch: string) {
  if (!isDispatchBranch(branch)) {
    console.warn(`[mission-branch-cleanup] Refusing to delete non-dispatch branch ${branch}.`);
    return false;
  }

  if (!(await localBranchExists(repoPath, branch))) {
    return false;
  }

  await execFileAsync('git', ['branch', '-D', branch], {
    cwd: repoPath,
    timeout: 10_000,
  }).catch((error) => {
    throw new Error(`Unable to delete branch ${branch}: ${formatError(error)}`);
  });

  return true;
}

async function lanesForBranch(repoPath: string, branch: string) {
  const { listLanes } = await import('@/lib/lane/registry');
  return listLanes().filter((lane) => sameRepo(lane.repoPath, repoPath) && lane.branch === branch);
}

async function archiveLanesForBranch(repoPath: string, branch: string) {
  const { archiveLane, updateLane } = await import('@/lib/lane/registry');
  const lanes = await lanesForBranch(repoPath, branch);
  const worktreePaths = lanes
    .map((lane) => lane.worktreePath?.trim())
    .filter((path): path is string => Boolean(path));
  let archived = 0;

  for (const lane of lanes) {
    if (isTerminalLane(lane)) {
      updateLane(lane.id, { packetId: '', worktreePath: null }, 'system');
      continue;
    }

    const updated = archiveLane(lane.id, 'system');
    if (!updated) continue;
    updateLane(lane.id, { packetId: '', worktreePath: null }, 'system');
    archived += 1;
  }

  return { archived, worktreePaths };
}

async function probeExistingBranch(repoPath: string, branch: string): Promise<ExistingBranchProbe> {
  const [lanes, hasBranch, worktrees] = await Promise.all([
    lanesForBranch(repoPath, branch),
    localBranchExists(repoPath, branch),
    gitWorktreesForBranch(repoPath, branch),
  ]);

  return {
    activeLanes: lanes.filter((lane) => !isTerminalLane(lane)),
    staleLanes: lanes.filter(isTerminalLane),
    hasBranch,
    hasWorktree: worktrees.length > 0 || lanes.some((lane) => Boolean(lane.worktreePath)),
  };
}

export async function cleanupIssueBranch(
  repoPath: string,
  branch: string,
): Promise<IssueBranchCleanupResult> {
  const branchExisted = await localBranchExists(repoPath, branch);
  const { archived, worktreePaths } = await archiveLanesForBranch(repoPath, branch);
  const worktreesRemoved = await cleanupWorktreesForBranch(repoPath, branch, worktreePaths);
  const deleted = await deleteLocalBranch(repoPath, branch);
  const branchDeleted = branchExisted && (deleted || !(await localBranchExists(repoPath, branch)));

  return {
    lanesArchived: archived,
    worktreePruned: worktreesRemoved > 0,
    branchDeleted,
    branchExisted,
  };
}

export async function prepareMissionBranches(input: {
  repoPath: string;
  candidates: MissionBranchCandidate[];
  previousPackets: Array<{
    issue?: { number?: number; body?: string } | null;
    title: string;
    branchTarget: string;
    workspaceTargetPath: string | null;
  }>;
  existingBranchPolicy?: ExistingBranchPolicy;
}): Promise<MissionBranchDecision[]> {
  const policy = input.existingBranchPolicy ?? 'auto';
  const decisions: MissionBranchDecision[] = [];

  for (const candidate of input.candidates) {
    const priorPacket = input.previousPackets.find((packet) => (
      sameRepo(packet.workspaceTargetPath ?? '', input.repoPath)
      && (
        packet.issue?.number === candidate.issue.number
        || packet.branchTarget === candidate.branchTarget
      )
    ));
    const specChanged = priorPacket
      ? issueSpec({
        number: candidate.issue.number,
        title: candidate.issue.title,
        body: candidate.issue.body,
        url: candidate.issue.url,
      }) !== issueSpec({
        number: priorPacket.issue?.number ?? candidate.issue.number,
        title: priorPacket.title,
        body: priorPacket.issue?.body ?? '',
        url: '',
      })
      : false;
    const probe = await probeExistingBranch(input.repoPath, candidate.branchTarget);
    const hasPrior = probe.activeLanes.length > 0
      || probe.staleLanes.length > 0
      || probe.hasBranch
      || probe.hasWorktree;

    if (!hasPrior) {
      decisions.push({
        issueNumber: candidate.issue.number,
        branchTarget: candidate.branchTarget,
        action: 'none',
        reason: 'no_prior_attempt',
        lanesArchived: 0,
        worktreePruned: false,
        branchDeleted: false,
      });
      continue;
    }

    if (policy === 'continue' && !specChanged) {
      if (probe.activeLanes.length === 0) {
        throw new Error(
          `Prior branch exists for #${candidate.issue.number} on ${candidate.branchTarget}, but there is no active lane to continue. `
          + 'Re-run create_mission with existingBranchPolicy:"reset" to delete the stale branch and start fresh from main.',
        );
      }
      decisions.push({
        issueNumber: candidate.issue.number,
        branchTarget: candidate.branchTarget,
        action: 'continued',
        reason: 'operator_continue',
        lanesArchived: 0,
        worktreePruned: false,
        branchDeleted: false,
      });
      continue;
    }

    // Pipeline root fix (2026-07-03): only an EXPLICIT operator reset may
    // clear ACTIVE lanes. Previously a derived reset (stale sibling present,
    // or spec drift) fell through to cleanupIssueBranch and archived the LIVE
    // lane on the same branch target — running work destroyed by a collision
    // it did not cause. Auto now surfaces the ambiguity instead of resolving
    // it destructively.
    if (policy === 'error' || (policy !== 'reset' && probe.activeLanes.length > 0)) {
      const laneSummary = probe.activeLanes
        .map((lane) => `${lane.id} (${lane.status})`)
        .join(', ');
      throw new Error(
        `Prior attempt exists for #${candidate.issue.number} on ${candidate.branchTarget}: ${laneSummary}. `
        + 'Re-run create_mission with existingBranchPolicy:"reset" to start fresh from main, '
        + 'or existingBranchPolicy:"continue" to resume the existing branch.',
      );
    }

    const cleanup = await cleanupIssueBranch(input.repoPath, candidate.branchTarget);
    decisions.push({
      issueNumber: candidate.issue.number,
      branchTarget: candidate.branchTarget,
      action: 'reset',
      reason: policy === 'reset' ? 'operator_reset' : specChanged ? 'spec_changed' : 'stale_prior_attempt',
      lanesArchived: cleanup.lanesArchived,
      worktreePruned: cleanup.worktreePruned,
      branchDeleted: cleanup.branchDeleted,
    });
  }

  return decisions;
}
