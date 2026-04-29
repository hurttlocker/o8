/**
 * GET /api/worktrees/diff?sessionKey=<sessionKey>
 *                        [&worktreePath=<path>]
 *                        [&baseBranch=<name>]
 *
 * Returns the full unified diff body for an agent's worktree, comparing the
 * branch + dirty tree against the base. Powers the mobile inline diff viewer.
 *
 * Resolution mirrors `diff-summary`:
 *   1. Explicit worktreePath param wins.
 *   2. Lane lookup by sessionKey.
 *   3. 404-equivalent empty body.
 */

export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { requirePanelAuth } from '@/lib/panel/auth';
import { findLaneBySession } from '@/lib/lane/registry';

const execFileAsync = promisify(execFile);

interface DiffResponse {
  sessionKey: string | null;
  worktreePath: string | null;
  baseBranch: string | null;
  diff: string;
  additions: number;
  deletions: number;
  fileCount: number;
  error?: string;
}

const MAX_DIFF_BYTES = 4 * 1024 * 1024;

function resolvePath(raw: string | null) {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('~')) return trimmed.replace('~', homedir());
  return trimmed;
}

async function runGit(cwd: string, args: string[], maxBuffer = MAX_DIFF_BYTES) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 10_000,
    maxBuffer,
  });
  return stdout;
}

async function collectDiff(cwd: string, baseBranch: string | null) {
  const sections: string[] = [];

  if (baseBranch) {
    try {
      const branchDiff = await runGit(cwd, ['diff', '--no-color', `${baseBranch}...HEAD`]);
      if (branchDiff.trim()) sections.push(branchDiff);
    } catch {
      // ignore — falls back to dirty-tree diff
    }
  }

  try {
    const dirtyDiff = await runGit(cwd, ['diff', '--no-color', 'HEAD']);
    if (dirtyDiff.trim()) sections.push(dirtyDiff);
  } catch {
    // ignore
  }

  // Track per-file totals across both numstat runs to avoid double-counting
  // files that appear in both the base-branch diff and the dirty-tree diff.
  const fileStats = new Map<string, { additions: number; deletions: number }>();

  async function consumeNumstat(args: string[]) {
    try {
      const out = await runGit(cwd, args);
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const [addStr = '0', delStr = '0', ...rest] = line.split('\t');
        const filePath = rest.join('\t');
        if (!filePath) continue;
        const add = addStr !== '-' ? (Number.parseInt(addStr, 10) || 0) : 0;
        const del = delStr !== '-' ? (Number.parseInt(delStr, 10) || 0) : 0;
        const existing = fileStats.get(filePath);
        if (existing) {
          // Already seen this file — keep the higher stat (prefer broader diff).
          existing.additions = Math.max(existing.additions, add);
          existing.deletions = Math.max(existing.deletions, del);
        } else {
          fileStats.set(filePath, { additions: add, deletions: del });
        }
      }
    } catch {
      // ignore
    }
  }

  if (baseBranch) await consumeNumstat(['diff', '--numstat', `${baseBranch}...HEAD`]);
  await consumeNumstat(['diff', '--numstat', 'HEAD']);

  let additions = 0;
  let deletions = 0;
  for (const stat of fileStats.values()) {
    additions += stat.additions;
    deletions += stat.deletions;
  }

  return {
    diff: sections.join('\n'),
    additions,
    deletions,
    fileCount: fileStats.size,
  };
}

export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const sessionKey = req.nextUrl.searchParams.get('sessionKey');
  const worktreePathParam = resolvePath(req.nextUrl.searchParams.get('worktreePath'));
  const baseBranchParam = req.nextUrl.searchParams.get('baseBranch');

  let worktreePath = worktreePathParam || null;
  let baseBranch = baseBranchParam || null;

  if (!worktreePath && sessionKey) {
    try {
      const lane = findLaneBySession(sessionKey);
      if (lane) {
        worktreePath = lane.worktreePath ?? lane.repoPath ?? null;
        if (!baseBranch) baseBranch = lane.baseBranch ?? null;
      }
    } catch {
      // ignore — fall through to error response below
    }
  }

  const empty = (error?: string): DiffResponse => ({
    sessionKey,
    worktreePath,
    baseBranch,
    diff: '',
    additions: 0,
    deletions: 0,
    fileCount: 0,
    error,
  });

  if (!worktreePath) return NextResponse.json(empty('worktree_not_found'));
  if (!existsSync(worktreePath)) return NextResponse.json(empty('worktree_path_missing'));

  try {
    const result = await collectDiff(worktreePath, baseBranch);
    const value: DiffResponse = {
      sessionKey,
      worktreePath,
      baseBranch,
      ...result,
    };
    return NextResponse.json(value, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json(empty(error instanceof Error ? error.message : 'Unknown error'));
  }
}
