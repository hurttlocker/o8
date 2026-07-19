/**
 * GET /api/worktrees/diff-summary?sessionKey=<sessionKey>
 *                                 [&worktreePath=<path>]
 *                                 [&baseBranch=<name>]
 *
 * Returns exact, revisioned metadata for the branch + dirty worktree delta.
 * The response remains backward-compatible with the original aggregate-only
 * shape while adding stable file anchors for bounded follow-up diff requests.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { NextResponse, type NextRequest } from 'next/server';

import { findLaneBySession } from '@/lib/lane/registry';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import {
  collectWorktreeDiffSnapshot,
  type WorktreeDiffFile,
  worktreeDiffErrorMessage,
} from '@/lib/worktree/diff-transport';

interface DiffSummaryResponse {
  sessionKey: string | null;
  worktreePath: string | null;
  baseBranch: string | null;
  headSha: string | null;
  revision: string | null;
  additions: number;
  deletions: number;
  fileCount: number;
  files: WorktreeDiffFile[];
  truncated: false;
  error?: string;
}

function resolvePath(raw: string | null): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('~')) return trimmed.replace('~', homedir());
  return trimmed;
}

function resolveWorktreeForSession(
  sessionKey: string,
): { worktreePath: string | null; baseBranch: string | null } {
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
  // Operator or the operator's enrolled phone may read review diff summaries; a
  // dispatched worker has no need for them.
  const principal = resolveRequestPrincipal(req);
  if (principal === 'worker') {
    return NextResponse.json({ error: 'A dispatched worker cannot read review diffs.' }, { status: 403 });
  }
  if (principal !== 'operator' && principal !== 'device') {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const sessionKey = req.nextUrl.searchParams.get('sessionKey');
  const worktreePathParam = resolvePath(req.nextUrl.searchParams.get('worktreePath'));
  const baseBranchParam = req.nextUrl.searchParams.get('baseBranch');

  let worktreePath = worktreePathParam || null;
  let baseBranch = baseBranchParam || null;

  if (!worktreePath && sessionKey) {
    const resolved = resolveWorktreeForSession(sessionKey);
    worktreePath = resolved.worktreePath;
    if (!baseBranch) baseBranch = resolved.baseBranch;
  }

  const emptySummary = (error: string): DiffSummaryResponse => ({
    sessionKey,
    worktreePath,
    baseBranch,
    headSha: null,
    revision: null,
    additions: 0,
    deletions: 0,
    fileCount: 0,
    files: [],
    truncated: false,
    error,
  });

  if (!worktreePath) return NextResponse.json(emptySummary('worktree_not_found'));
  if (!existsSync(worktreePath)) return NextResponse.json(emptySummary('worktree_path_missing'));

  try {
    const snapshot = await collectWorktreeDiffSnapshot(worktreePath, baseBranch);
    const value: DiffSummaryResponse = {
      sessionKey,
      worktreePath,
      baseBranch,
      headSha: snapshot.headSha,
      revision: snapshot.revision,
      additions: snapshot.additions,
      deletions: snapshot.deletions,
      fileCount: snapshot.files.length,
      files: snapshot.files,
      truncated: false,
    };
    return NextResponse.json(value, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    return NextResponse.json(emptySummary(worktreeDiffErrorMessage(error)));
  }
}
