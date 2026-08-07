import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { NextResponse, type NextRequest } from 'next/server';
import { createLane, setLaneStatus } from '@/lib/lane/registry';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getWorktreeManager } from '@/lib/worktree/launch';
import type { WorktreeInfo } from '@/lib/worktree/types';

const execFileAsync = promisify(execFile);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ApplyDiffBody {
  diffText?: string;
  repoPath?: string;
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  let body: ApplyDiffBody;
  try {
    body = (await request.json()) as ApplyDiffBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const diffText = body.diffText?.trim();
  const repoPath = body.repoPath?.trim();

  if (!diffText || !repoPath) {
    return NextResponse.json({ error: 'diffText and repoPath are required.' }, { status: 400 });
  }

  const timestamp = Date.now();
  const branchName = `diff-apply-${timestamp}`;
  const manager = getWorktreeManager(repoPath);
  let tempDirPath: string | null = null;
  let worktree: WorktreeInfo | null = null;

  try {
    worktree = await manager.create({
      agentType: 'codex',
      taskName: `diff-${timestamp}`,
      branchName,
      skipSetup: true,
    });

    tempDirPath = await mkdtemp(join(tmpdir(), 'cortex-diff-'));
    const patchPath = join(tempDirPath, 'apply.diff');
    await writeFile(patchPath, diffText, 'utf8');

    await execFileAsync('git', ['apply', patchPath], {
      windowsHide: true,
      cwd: worktree.path,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    // LaneRuntime only supports CLI runtimes today, so diff-apply lanes use
    // the managed codex lane shape until operator lanes are first-class.
    const lane = createLane({
      repoPath,
      branch: worktree.branch,
      baseBranch: worktree.baseBranch,
      runtime: 'codex',
      label: 'Diff apply',
      worktreePath: worktree.path,
      actor: 'user',
    });
    setLaneStatus(lane.id, 'reviewing', 'user', 'diff_applied');

    return NextResponse.json({
      laneId: lane.id,
      branch: worktree.branch,
      status: 'applied',
    });
  } catch (error) {
    if (worktree) {
      try {
        await manager.cleanup(worktree.id, { force: true, deleteBranch: true });
      } catch (cleanupError) {
        console.error('[diff-card] Failed to clean up worktree after apply error:', cleanupError);
      }
    }

    const message = error instanceof Error ? error.message : 'Unable to apply diff.';
    const status = /apply|patch|diff/i.test(message) ? 422 : 500;
    return NextResponse.json({ error: message }, { status });
  } finally {
    if (tempDirPath) {
      await rm(tempDirPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
