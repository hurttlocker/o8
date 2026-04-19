/**
 * GET /api/worktrees/diff-summary?sessionKey=<sessionKey>
 *                                 [&worktreePath=<path>]
 *                                 [&baseBranch=<name>]
 *
 * Returns `{ additions, deletions, fileCount }` for a single agent's worktree,
 * comparing the dirty tree against the agent's base branch. Powers the agent
 * hover card's diff line — the single most valuable signal for deciding
 * whether to approve a working agent.
 *
 * Resolution order for the worktree path:
 *   1. Explicit `worktreePath` param (caller already knows).
 *   2. Lane record lookup by `sessionKey` (governance-tracked agents).
 *   3. Fall back to 404 with a structured empty summary.
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

interface DiffSummary {
  additions: number;
  deletions: number;
  fileCount: number;
}

interface DiffSummaryResponse extends DiffSummary {
  sessionKey: string | null;
  worktreePath: string | null;
  baseBranch: string | null;
  error?: string;
}

const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { value: DiffSummaryResponse; ts: number }>();

function resolvePath(raw: string | null) {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('~')) return trimmed.replace('~', homedir());
  return trimmed;
}

async function runGit(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 5_000,
    maxBuffer: 512 * 1024,
  });
  return stdout;
}

async function collectDiff(cwd: string, baseBranch: string | null): Promise<DiffSummary> {
  // Compare the worktree HEAD against the lane's base branch — this is the
  // same diff the reviewer would see when approving the agent's work. We
  // fall back to `HEAD` (staged + unstaged only) when no baseBranch is known
  // so we never hard-fail on agents that haven't committed yet.
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;

  async function consume(args: string[]) {
    try {
      const output = await runGit(cwd, args);
      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        const [addStr = '0', delStr = '0', ...rest] = line.split('\t');
        const filePath = rest.join('\t');
        if (!filePath) continue;
        files.add(filePath);
        if (addStr !== '-') additions += Number.parseInt(addStr, 10) || 0;
        if (delStr !== '-') deletions += Number.parseInt(delStr, 10) || 0;
      }
    } catch {
      // ignore individual git failures; fall back to other strategies
    }
  }

  if (baseBranch) {
    await consume(['diff', '--numstat', `${baseBranch}...HEAD`]);
  }
  // Always layer the dirty tree on top so we capture work the agent hasn't
  // committed yet. Any file already counted by the base-branch diff is
  // de-duplicated via the `files` Set below; the add/del counts do add up
  // twice when a file is both committed-on-branch and dirty, but that's a
  // fine approximation for a hover card.
  await consume(['diff', 'HEAD', '--numstat']);

  try {
    const untracked = await runGit(cwd, ['ls-files', '--others', '--exclude-standard']);
    for (const line of untracked.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }
  } catch {
    // ignore — untracked count is a nice-to-have, not required
  }

  return { additions, deletions, fileCount: files.size };
}

async function resolveWorktreeForSession(
  sessionKey: string,
): Promise<{ worktreePath: string | null; baseBranch: string | null }> {
  try {
    const lane = findLaneBySession(sessionKey);
    if (!lane) return { worktreePath: null, baseBranch: null };
    return {
      worktreePath: lane.worktreePath ?? lane.repoPath ?? null,
      baseBranch: lane.baseBranch ?? null,
    };
  } catch {
    return { worktreePath: null, baseBranch: null };
  }
}

export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const sessionKey = req.nextUrl.searchParams.get('sessionKey');
  const worktreePathParam = resolvePath(req.nextUrl.searchParams.get('worktreePath'));
  const baseBranchParam = req.nextUrl.searchParams.get('baseBranch');

  const cacheKey = `${sessionKey ?? ''}|${worktreePathParam}|${baseBranchParam ?? ''}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.value, { headers: { 'Cache-Control': 'no-store' } });
  }

  const emptySummary = (worktreePath: string | null, baseBranch: string | null, error?: string): DiffSummaryResponse => ({
    sessionKey,
    worktreePath,
    baseBranch,
    additions: 0,
    deletions: 0,
    fileCount: 0,
    error,
  });

  let worktreePath = worktreePathParam || null;
  let baseBranch = baseBranchParam || null;

  if (!worktreePath && sessionKey) {
    const resolved = await resolveWorktreeForSession(sessionKey);
    worktreePath = resolved.worktreePath;
    if (!baseBranch) baseBranch = resolved.baseBranch;
  }

  if (!worktreePath) {
    const value = emptySummary(null, baseBranch, 'worktree_not_found');
    cache.set(cacheKey, { value, ts: Date.now() });
    return NextResponse.json(value);
  }

  if (!existsSync(worktreePath)) {
    const value = emptySummary(worktreePath, baseBranch, 'worktree_path_missing');
    cache.set(cacheKey, { value, ts: Date.now() });
    return NextResponse.json(value);
  }

  try {
    const summary = await collectDiff(worktreePath, baseBranch);
    const value: DiffSummaryResponse = {
      sessionKey,
      worktreePath,
      baseBranch,
      ...summary,
    };
    cache.set(cacheKey, { value, ts: Date.now() });
    return NextResponse.json(value);
  } catch (error) {
    const value = emptySummary(
      worktreePath,
      baseBranch,
      error instanceof Error ? error.message : 'Unknown error',
    );
    return NextResponse.json(value);
  }
}
