import { execFileSync } from 'node:child_process';
import type { Lane } from '@/lib/lane/types';

export interface LaneDiffFacts {
  changedFiles: string[];
  addedLines: string[];
}

export function extractAddedLines(diff: string): string[] {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'));
}

/** Parse `git diff --stat` output into per-file insertion/deletion counts. */
export function parseDiffStat(stat: string): Array<{ file: string; insertions: number; deletions: number }> {
  const results: Array<{ file: string; insertions: number; deletions: number }> = [];
  for (const line of stat.split('\n')) {
    // Format: " src/foo.ts | 42 +++++-----"  or  " src/foo.ts | 10 ++++"
    const match = line.match(/^\s*(.+?)\s*\|\s*(\d+)\s/);
    if (!match) continue;
    const file = match[1].trim();
    const plusMatch = line.match(/(\d+)\s*insertion/);
    const minusMatch = line.match(/(\d+)\s*deletion/);
    // Fallback: count + and - symbols in the bar chart
    const barMatch = line.match(/\|\s*\d+\s+([\s+\-]+)$/);
    let insertions = plusMatch ? parseInt(plusMatch[1], 10) : 0;
    let deletions = minusMatch ? parseInt(minusMatch[1], 10) : 0;
    if (!plusMatch && !minusMatch && barMatch) {
      const bar = barMatch[1];
      insertions = (bar.match(/\+/g) || []).length;
      deletions = (bar.match(/-/g) || []).length;
    }
    if (file && (insertions > 0 || deletions > 0)) {
      results.push({ file, insertions, deletions });
    }
  }
  return results;
}

function readGitOutput(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    timeout: 10_000,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function readGitOutputWithFallback(cwd: string, primaryArgs: string[], fallbackArgs: string[]): string {
  try {
    return readGitOutput(cwd, primaryArgs);
  } catch {
    try {
      return readGitOutput(cwd, fallbackArgs);
    } catch {
      return '';
    }
  }
}

export function getLaneDiffFacts(
  lane: Pick<Lane, 'baseBranch' | 'worktreePath' | 'repoPath'>,
): LaneDiffFacts {
  const cwd = lane.worktreePath || lane.repoPath;
  if (!cwd) {
    throw new Error('Lane has no repository path for diff facts.');
  }

  const baseRange = `${lane.baseBranch}...HEAD`;
  const stat = readGitOutputWithFallback(
    cwd,
    ['diff', '--stat', baseRange],
    ['diff', '--stat', 'HEAD~1'],
  );
  const diff = readGitOutputWithFallback(
    cwd,
    ['diff', baseRange, '--no-color', '-U2'],
    ['diff', 'HEAD~1', '--no-color', '-U2'],
  );

  return {
    changedFiles: stat ? parseDiffStat(stat).map((entry) => entry.file) : [],
    addedLines: extractAddedLines(diff),
  };
}
