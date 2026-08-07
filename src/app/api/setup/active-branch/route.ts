import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { NextResponse } from 'next/server';
import { listLanes } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { readRepoPathRegistry, type RegisteredRepoPathEntry } from '@/lib/repos/repo-path-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);

function canonicalizeRepoPath(repoPath: string) {
  const resolved = path.resolve(repoPath);
  return resolved
    .replace(/\/\.cortex-worktrees\/[^/]+.*$/, '')
    .replace(/\/\.claude\/worktrees\/[^/]+.*$/, '');
}

function repoDefaultBranch(repo: RegisteredRepoPathEntry | null) {
  return typeof repo?.defaultBranch === 'string' && repo.defaultBranch.trim()
    ? repo.defaultBranch.trim()
    : 'main';
}

async function resolveActiveRepo() {
  const registry = await readRepoPathRegistry();
  if (!registry.ok) {
    return { ok: false as const, message: registry.message };
  }

  const cwdRepoPath = canonicalizeRepoPath(
    process.env.CORTEX_IDE_REPO_ROOT || process.env.CORTEX_IDE_WORKSPACE_ROOT || process.cwd(),
  );
  const repo = registry.repos.find((entry) => entry.path === cwdRepoPath) ?? null;

  return {
    ok: true as const,
    repo,
    repoPath: repo?.path ?? cwdRepoPath,
    expectedBranch: repoDefaultBranch(repo),
  };
}

async function readCurrentBranch(repoPath: string) {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    windowsHide: true,
    cwd: repoPath,
    timeout: 5_000,
  });
  return stdout.trim() || 'HEAD';
}

function isActiveLane(lane: Lane) {
  return lane.status !== 'archived' && lane.status !== 'completed';
}

function safeListLanes() {
  try {
    return listLanes();
  } catch {
    return [];
  }
}

function findDriftWorktreeMatch(repoPath: string, branch: string) {
  return safeListLanes().find((lane) =>
    isActiveLane(lane)
    && canonicalizeRepoPath(lane.repoPath) === repoPath
    && lane.branch === branch
    && Boolean(lane.worktreePath)
  ) ?? null;
}

export async function GET() {
  const resolved = await resolveActiveRepo();
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.message }, { status: 500 });
  }

  try {
    const mainRepoBranch = await readCurrentBranch(resolved.repoPath);
    const hasDrift = mainRepoBranch !== resolved.expectedBranch;
    const match = hasDrift ? findDriftWorktreeMatch(resolved.repoPath, mainRepoBranch) : null;

    return NextResponse.json({
      repoPath: resolved.repoPath,
      mainRepoBranch,
      expectedBranch: resolved.expectedBranch,
      driftWarning: hasDrift
        ? `Main repo is on ${mainRepoBranch}; expected ${resolved.expectedBranch}.`
        : null,
      driftWorktreeMatch: match ? {
        packetId: match.packetId,
        branch: match.branch,
        worktreePath: match.worktreePath,
      } : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read active branch';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
