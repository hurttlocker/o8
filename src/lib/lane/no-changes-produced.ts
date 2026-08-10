import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolvePacketDiffBase } from '@/lib/diff/base-resolution';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER = 10 * 1024 * 1024;

export interface NoChangesProducedProbe {
  commitsAhead: number;
  comparisonRef: string;
  statusPorcelain: string;
  noChangesProduced: boolean;
}

export async function probeNoChangesProduced(
  cwd: string,
  baseBranch: string,
): Promise<NoChangesProducedProbe> {
  const baseRef = baseBranch.trim() || 'main';
  const { stdout: headStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    windowsHide: true,
    cwd,
    maxBuffer: COMMAND_MAX_BUFFER,
  });
  const diffBase = await resolvePacketDiffBase(cwd, baseRef, headStdout.trim());
  const { stdout: countStdout } = await execFileAsync(
    'git',
    ['rev-list', '--count', `${diffBase.comparisonRef}..HEAD`],
    { windowsHide: true, cwd, maxBuffer: COMMAND_MAX_BUFFER },
  );
  const commitsAhead = Number.parseInt(countStdout.trim(), 10);
  if (!Number.isFinite(commitsAhead)) {
    throw new Error(`Unable to parse git rev-list count: ${countStdout.trim() || '<empty>'}`);
  }

  const { stdout: statusStdout } = await execFileAsync('git', ['status', '--porcelain'], {
    windowsHide: true,
    cwd,
    maxBuffer: COMMAND_MAX_BUFFER,
  });
  const statusPorcelain = statusStdout.trim();

  return {
    commitsAhead,
    comparisonRef: diffBase.comparisonRef,
    statusPorcelain,
    noChangesProduced: commitsAhead === 0 && statusPorcelain.length === 0,
  };
}
