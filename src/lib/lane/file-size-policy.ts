import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Lane } from '@/lib/lane/types';
import { FILE_SIZE_BLOCK_THRESHOLD_LINES, FILE_SIZE_WAIVERS } from '@/lib/orchestrator/dispatch';

const execFileAsync = promisify(execFile);

export interface OversizedChangedFile {
  path: string;
  lineCount: number;
  originalLineCount: number | null;
}

export function formatOversizedFiles(files: OversizedChangedFile[]) {
  if (files.length === 0) {
    return 'none';
  }

  const labels = files.map((file) => `${file.path} (${file.lineCount}L)`);
  if (labels.length <= 4) {
    return labels.join(', ');
  }

  return `${labels.slice(0, 4).join(', ')} (+${labels.length - 4} more)`;
}

function parseLineCount(output: string) {
  const match = output.match(/^\s*(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function parseOriginalLineCount(currentLineCount: number, diffOutput: string) {
  const diffLine = diffOutput.split('\n').find(Boolean);
  const [addedRaw, deletedRaw] = diffLine?.split('\t') ?? [];
  const added = Number.parseInt(addedRaw ?? '', 10);
  const deleted = Number.parseInt(deletedRaw ?? '', 10);
  return Number.isFinite(added) && Number.isFinite(deleted)
    ? Math.max(0, currentLineCount - (added - deleted))
    : null;
}

export async function getOversizedChangedFilesForLane(
  lane: Pick<Lane, 'baseBranch' | 'worktreePath'>,
) {
  if (!lane.worktreePath) {
    return [];
  }

  try {
    const result = await execFileAsync('git', ['diff', '--name-only', `${lane.baseBranch}...HEAD`], {
      windowsHide: true,
      cwd: lane.worktreePath,
      maxBuffer: 4 * 1024 * 1024,
    });
    const changedFiles = Array.from(new Set(
      String(result.stdout)
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean),
    ));

    const lineCounts = await Promise.allSettled(
      changedFiles.map(async (filePath) => {
        const wcResult = await execFileAsync('wc', ['-l', filePath], {
          windowsHide: true,
          cwd: lane.worktreePath!,
          maxBuffer: 256 * 1024,
        });
        let diffOutput = '';
        try {
          const diffResult = await execFileAsync('git', ['diff', '--numstat', `${lane.baseBranch}...HEAD`, '--', filePath], {
            windowsHide: true,
            cwd: lane.worktreePath!,
            maxBuffer: 256 * 1024,
          });
          diffOutput = String(diffResult.stdout);
        } catch {
          diffOutput = '';
        }
        const lineCount = parseLineCount(String(wcResult.stdout));
        if (lineCount === null) {
          return null;
        }

        return {
          path: filePath,
          lineCount,
          originalLineCount: parseOriginalLineCount(lineCount, diffOutput),
        };
      }),
    );

    return lineCounts
      .flatMap((entry) => (entry.status === 'fulfilled' && entry.value ? [entry.value] : []))
      .filter((file) => !FILE_SIZE_WAIVERS.has(file.path)
        && file.lineCount > FILE_SIZE_BLOCK_THRESHOLD_LINES
        && (file.originalLineCount === null || file.lineCount > file.originalLineCount))
      .sort((left, right) => right.lineCount - left.lineCount || left.path.localeCompare(right.path));
  } catch {
    return [];
  }
}
