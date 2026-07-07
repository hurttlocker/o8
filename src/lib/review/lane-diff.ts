import type { ReviewChangedFile } from '@/lib/fleet/types';
import { parseGitDiff } from '@/lib/worktree/diff-parser';

export interface LaneReviewChangedFile extends ReviewChangedFile {
  patch: string;
}

export interface LaneReviewDiffSummary {
  files: LaneReviewChangedFile[];
  additions: number;
  deletions: number;
}

function statusFromDiff(status: 'A' | 'M' | 'D' | 'R'): ReviewChangedFile['status'] {
  if (status === 'A') return 'added';
  if (status === 'D') return 'deleted';
  if (status === 'R') return 'renamed';
  return 'modified';
}

function countPatchLines(patch: string) {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

export function summarizeLaneReviewDiff(diff: string): LaneReviewDiffSummary {
  const files = parseGitDiff(diff).map((file) => {
    const counts = countPatchLines(file.patch);
    return {
      path: file.path,
      status: statusFromDiff(file.status),
      additions: counts.additions,
      deletions: counts.deletions,
      staged: false,
      unstaged: false,
      patch: file.patch,
    } satisfies LaneReviewChangedFile;
  });
  return {
    files,
    additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  };
}
