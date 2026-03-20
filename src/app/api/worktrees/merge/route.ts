/**
 * Worktree Merge API
 *
 * POST /api/worktrees/merge — Create PR, merge to main, or discard a worktree
 *
 * @see https://github.com/hurttlocker/cortex-ide/issues/70
 */

export const dynamic = 'force-dynamic';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextResponse, type NextRequest } from 'next/server';
import { requestRealtimeRefresh } from '@/lib/realtime/publisher';
import { getWorktreeManager } from '@/lib/worktree/launch';
import type { MergeResult } from '@/lib/worktree/types';

const execFileAsync = promisify(execFile);

const API_TOKEN = process.env.WS_TOKEN ?? 'cortex-ide';

function isTrustedPanelRequest(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (origin && origin === req.nextUrl.origin) {
    return true;
  }

  return req.headers.get('sec-fetch-site') === 'same-origin';
}

function checkAuth(req: NextRequest): NextResponse | null {
  if (isTrustedPanelRequest(req)) {
    return null;
  }

  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : req.nextUrl.searchParams.get('token');
  if (token !== API_TOKEN) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

interface MergeBody {
  repo: string;
  worktreeId: string;
  action: 'pr' | 'merge' | 'discard';
  /** Target branch for merge (default: main) */
  targetBranch?: string;
  /** PR title override */
  prTitle?: string;
  /** PR body override */
  prBody?: string;
}

export async function POST(req: NextRequest) {
  const denied = checkAuth(req);
  if (denied) return denied;

  let body: MergeBody;
  try {
    body = (await req.json()) as MergeBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.repo || !body.worktreeId || !body.action) {
    return NextResponse.json(
      { error: 'repo, worktreeId, and action are required' },
      { status: 400 },
    );
  }

  const mgr = getWorktreeManager(body.repo);
  const worktree = await mgr.get(body.worktreeId);

  if (!worktree) {
    return NextResponse.json({ error: 'Worktree not found' }, { status: 404 });
  }

  try {
    let result: MergeResult;

    switch (body.action) {
      case 'pr':
        result = await createPR(worktree.path, worktree.branch, worktree.dirtyFiles, {
          title: body.prTitle,
          body: body.prBody,
          targetBranch: body.targetBranch ?? 'main',
          agentType: worktree.agentType,
          createdAt: worktree.createdAt,
        });
        // Cleanup worktree but keep branch (PR needs it)
        if (result.ok) {
          await mgr.cleanup(body.worktreeId, { force: true, deleteBranch: false });
        }
        break;

      case 'merge':
        result = await mergeToTarget(body.repo, worktree.path, worktree.branch, body.targetBranch ?? 'main');
        if (result.ok) {
          await mgr.cleanup(body.worktreeId, { force: true, deleteBranch: true });
        }
        break;

      case 'discard':
        await mgr.cleanup(body.worktreeId, { force: true, deleteBranch: true });
        result = { action: 'discard', ok: true, note: `Discarded worktree ${body.worktreeId}` };
        break;

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }

    if (result.ok) {
      void requestRealtimeRefresh({
        targets: ['global', 'mobileInbox'],
        fresh: true,
        reason: `worktree.${body.action}`,
      });
    }

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

// ── PR Creation ──

async function createPR(
  worktreePath: string,
  branch: string,
  dirtyFiles: string[],
  opts: { title?: string; body?: string; targetBranch: string; agentType: string; createdAt?: number },
): Promise<MergeResult> {
  // Commit any uncommitted changes
  try {
    await execFileAsync('git', ['add', '-A'], { cwd: worktreePath, timeout: 10_000 });
    await execFileAsync('git', ['commit', '-m', `chore: worktree changes from ${opts.agentType}`], {
      cwd: worktreePath,
      timeout: 10_000,
    });
  } catch {
    // May already be committed — that's fine
  }

  // Push branch
  try {
    await execFileAsync('git', ['push', '-u', 'origin', branch], {
      cwd: worktreePath,
      timeout: 30_000,
    });
  } catch (err) {
    return {
      action: 'pr',
      ok: false,
      note: `Failed to push branch: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Get diffstat for PR body
  let diffstat = '';
  try {
    const { stdout: statOut } = await execFileAsync('git', [
      'diff', '--shortstat', `${opts.targetBranch}...HEAD`,
    ], { cwd: worktreePath, timeout: 5000 });
    diffstat = statOut.trim();
  } catch { /* non-critical */ }

  // Get duration estimate
  const durationMin = opts.createdAt
    ? Math.round((Date.now() - opts.createdAt) / 60_000)
    : undefined;

  // Create PR via gh CLI
  const taskName = branch.split('/').pop() ?? branch;
  const title = opts.title ?? `${opts.agentType}: ${taskName}`;
  const fileList = dirtyFiles.map((f) => `- \`${f}\``).join('\n');
  const prBody = opts.body ?? [
    `## Changes`,
    `**Agent:** ${opts.agentType}${durationMin ? ` · **Duration:** ${durationMin} min` : ''}`,
    `**Branch:** \`${branch}\`${diffstat ? ` · ${diffstat}` : ''}`,
    ``,
    `### Files Modified (${dirtyFiles.length})`,
    fileList,
    ``,
    `---`,
    `*Created by Cortex IDE WorktreeManager*`,
  ].join('\n');

  try {
    const { stdout } = await execFileAsync('gh', [
      'pr', 'create',
      '--title', title,
      '--body', prBody,
      '--base', opts.targetBranch,
      '--head', branch,
    ], { cwd: worktreePath, timeout: 30_000 });

    const prUrl = stdout.trim();
    return {
      action: 'pr',
      ok: true,
      note: `PR created: ${prUrl}`,
      prUrl,
    };
  } catch (err) {
    return {
      action: 'pr',
      ok: false,
      note: `Failed to create PR: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Direct Merge ──

async function mergeToTarget(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  targetBranch: string,
): Promise<MergeResult> {
  // Commit any uncommitted changes first
  try {
    await execFileAsync('git', ['add', '-A'], { cwd: worktreePath, timeout: 10_000 });
    await execFileAsync('git', ['commit', '-m', `chore: worktree changes`], {
      cwd: worktreePath,
      timeout: 10_000,
    });
  } catch {
    // Already committed
  }

  // Safety: refuse to merge if repo root has uncommitted changes
  try {
    const { stdout: dirtyCheck } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      timeout: 5000,
    });
    if (dirtyCheck.trim().length > 0) {
      return {
        action: 'merge',
        ok: false,
        note: 'Repo root has uncommitted changes. Commit or stash first, or use "Create PR" instead.',
      };
    }
  } catch {
    // If we can't check, refuse
    return {
      action: 'merge',
      ok: false,
      note: 'Could not verify repo root is clean. Use "Create PR" instead.',
    };
  }

  // Check for conflicts before merging using merge-tree (no working tree mutation)
  try {
    const { stdout: mergeCheck } = await execFileAsync('git', [
      'merge-tree', '--write-tree', targetBranch, branch,
    ], { cwd: repoRoot, timeout: 10_000 });

    if (mergeCheck.includes('CONFLICT')) {
      return {
        action: 'merge',
        ok: false,
        note: 'Merge conflicts detected. Use "Create PR" instead for manual resolution.',
      };
    }
  } catch {
    // merge-tree may not be available; fall through to try merge
  }

  // Save current branch to restore after merge
  let originalBranch: string | null = null;
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: repoRoot,
      timeout: 5000,
    });
    originalBranch = stdout.trim() || null;
  } catch { /* best effort */ }

  // Perform the merge
  try {
    await execFileAsync('git', ['checkout', targetBranch], {
      cwd: repoRoot,
      timeout: 10_000,
    });

    await execFileAsync('git', ['merge', '--no-ff', branch, '-m', `Merge worktree: ${branch}`], {
      cwd: repoRoot,
      timeout: 15_000,
    });

    // Restore original branch if it was different from target
    if (originalBranch && originalBranch !== targetBranch) {
      await execFileAsync('git', ['checkout', originalBranch], {
        cwd: repoRoot,
        timeout: 10_000,
      }).catch(() => { /* best effort restore */ });
    }

    return {
      action: 'merge',
      ok: true,
      note: `Merged ${branch} into ${targetBranch}`,
    };
  } catch (err) {
    // Abort any partial merge
    await execFileAsync('git', ['merge', '--abort'], { cwd: repoRoot, timeout: 5000 }).catch(() => {});
    // Restore original branch
    if (originalBranch) {
      await execFileAsync('git', ['checkout', originalBranch], {
        cwd: repoRoot,
        timeout: 10_000,
      }).catch(() => {});
    }
    return {
      action: 'merge',
      ok: false,
      note: `Merge failed: ${err instanceof Error ? err.message : String(err)}. Use "Create PR" instead.`,
    };
  }
}
