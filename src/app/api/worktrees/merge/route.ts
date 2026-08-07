/**
 * Worktree Merge API
 *
 * POST /api/worktrees/merge — Create PR, merge to main, or discard a worktree
 *
 * @see https://github.com/hurttlocker/o8/issues/70
 */

export const dynamic = 'force-dynamic';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { requestRealtimeRefresh } from '@/lib/realtime/publisher';
import { getWorktreeManager } from '@/lib/worktree/launch';
import type { MergeResult } from '@/lib/worktree/types';

const execFileAsync = promisify(execFile);

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
  const denied = requirePanelAuth(req);
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
        result = await mergeToTarget(body.repo, worktree.path, worktree.branch, body.targetBranch ?? 'main', {
          importBranchFromWorkspace: worktree.isolationKind === 'apfs-cow-clone',
        });
        if (result.ok) {
          await mgr.cleanup(body.worktreeId, { force: true, deleteBranch: true });
          // #538 — Post-merge decomposition pipeline. Never blocks the response
          // and never rolls back the merge on failure.
          try {
            const { enqueueDecompositionsAfterMerge } = await import('@/lib/dispatch/decomposition-pipeline');
            const runtime = worktree.agentType === 'claude-code' ? 'claude-code' : 'codex';
            await enqueueDecompositionsAfterMerge({
              repoPath: body.repo,
              runtime,
            });
          } catch (decompositionError) {
            console.warn(
              `[worktrees/merge] Decomposition scan failed for ${body.repo}: ${decompositionError instanceof Error ? decompositionError.message : String(decompositionError)}`,
            );
          }
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
    await execFileAsync('git', ['add', '-A'], { windowsHide: true, cwd: worktreePath, timeout: 10_000 });
    await execFileAsync('git', ['commit', '-m', `chore: worktree changes from ${opts.agentType}`], {
      windowsHide: true,
      cwd: worktreePath,
      timeout: 10_000,
    });
  } catch {
    // May already be committed — that's fine
  }

  // Push branch
  try {
    await execFileAsync('git', ['push', '-u', 'origin', branch], {
      windowsHide: true,
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
    ], { windowsHide: true, cwd: worktreePath, timeout: 5000 });
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
    `*Created by o8 WorktreeManager*`,
  ].join('\n');

  try {
    const { stdout } = await execFileAsync('gh', [
      'pr', 'create',
      '--title', title,
      '--body', prBody,
      '--base', opts.targetBranch,
      '--head', branch,
    ], { windowsHide: true, cwd: worktreePath, timeout: 30_000 });

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
  opts?: { importBranchFromWorkspace?: boolean },
): Promise<MergeResult> {
  // Commit any uncommitted changes first
  try {
    await execFileAsync('git', ['add', '-A'], { windowsHide: true, cwd: worktreePath, timeout: 10_000 });
    await execFileAsync('git', ['commit', '-m', `chore: worktree changes`], {
      windowsHide: true,
      cwd: worktreePath,
      timeout: 10_000,
    });
  } catch {
    // Already committed
  }

  if (opts?.importBranchFromWorkspace) {
    try {
      await execFileAsync('git', ['fetch', worktreePath, `${branch}:refs/heads/${branch}`], {
        windowsHide: true,
        cwd: repoRoot,
        timeout: 30_000,
      });
    } catch (err) {
      return {
        action: 'merge',
        ok: false,
        note: `Failed to import workspace branch before merge: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Safety: refuse to merge if repo root has uncommitted changes
  try {
    const { stdout: dirtyCheck } = await execFileAsync('git', ['status', '--porcelain'], {
      windowsHide: true,
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
    ], { windowsHide: true, cwd: repoRoot, timeout: 10_000 });

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
      windowsHide: true,
      cwd: repoRoot,
      timeout: 5000,
    });
    originalBranch = stdout.trim() || null;
  } catch { /* best effort */ }

  // Perform the merge
  try {
    await execFileAsync('git', ['checkout', targetBranch], {
      windowsHide: true,
      cwd: repoRoot,
      timeout: 10_000,
    });

    await execFileAsync('git', ['merge', '--no-ff', branch, '-m', `Merge worktree: ${branch}`], {
      windowsHide: true,
      cwd: repoRoot,
      timeout: 15_000,
    });

    // #534 — push the merge to origin. Failure here must NOT revert the merge:
    // the base branch already has the commit locally.
    let pushedToOrigin = false;
    let pushError: string | undefined;
    try {
      await execFileAsync('git', ['push', 'origin', targetBranch], {
        windowsHide: true,
        cwd: repoRoot,
        timeout: 60_000,
      });
      pushedToOrigin = true;
    } catch (pushErr) {
      pushError = pushErr instanceof Error ? pushErr.message : String(pushErr);
      console.warn(`[worktrees/merge] Push to origin failed for ${targetBranch} after merging ${branch}: ${pushError}`);
    }

    // Restore original branch if it was different from target
    if (originalBranch && originalBranch !== targetBranch) {
      await execFileAsync('git', ['checkout', originalBranch], {
        windowsHide: true,
        cwd: repoRoot,
        timeout: 10_000,
      }).catch(() => { /* best effort restore */ });
    }

    return {
      action: 'merge',
      ok: true,
      note: pushedToOrigin
        ? `Merged ${branch} into ${targetBranch} and pushed to origin.`
        : `Merged ${branch} into ${targetBranch} LOCALLY — push to origin failed: ${pushError ?? 'unknown error'}.`,
      pushedToOrigin,
      pushError,
    };
  } catch (err) {
    // Abort any partial merge
    await execFileAsync('git', ['merge', '--abort'], { windowsHide: true, cwd: repoRoot, timeout: 5000 }).catch(() => {});
    // Restore original branch
    if (originalBranch) {
      await execFileAsync('git', ['checkout', originalBranch], {
        windowsHide: true,
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
