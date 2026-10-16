import os from 'node:os';
import path from 'node:path';
import type { ReviewWorktreeSummary } from '@/lib/fleet/types';

export function parseWorktrees(raw: string, currentRoot: string) {
  const worktrees: ReviewWorktreeSummary[] = [];
  const records = raw
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean);

  for (const record of records) {
    let worktreePath = '';
    let branch: string | undefined;
    let head: string | undefined;
    let isBare = false;
    let isDetached = false;
    let lockedReason: string | undefined;
    let prunableReason: string | undefined;

    for (const line of record.split('\n')) {
      if (line.startsWith('worktree ')) worktreePath = line.replace('worktree ', '').trim();
      if (line.startsWith('branch ')) branch = line.replace('branch refs/heads/', '').trim();
      if (line.startsWith('HEAD ')) head = line.replace('HEAD ', '').trim().slice(0, 7);
      if (line === 'bare') isBare = true;
      if (line === 'detached') isDetached = true;
      if (line.startsWith('locked')) lockedReason = line.replace(/^locked\s*/, '').trim() || 'locked';
      if (line.startsWith('prunable')) prunableReason = line.replace(/^prunable\s*/, '').trim() || 'prunable';
    }

    if (!worktreePath) continue;

    worktrees.push({
      path: worktreePath.replace(os.homedir() + '/', '~/'),
      absolutePath: path.resolve(worktreePath),
      branch,
      head,
      isCurrent: path.resolve(worktreePath) === path.resolve(currentRoot),
      isBare,
      isDetached,
      lockedReason,
      prunableReason,
    });
  }

  return worktrees;
}
