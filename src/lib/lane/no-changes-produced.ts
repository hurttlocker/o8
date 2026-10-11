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
  runGit?: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
): Promise<NoChangesProducedProbe> {
  const execute = runGit ?? ((args: string[]) => execFileAsync('git', args, {
    windowsHide: true, cwd, maxBuffer: COMMAND_MAX_BUFFER,
  }));
  const baseRef = baseBranch.trim() || 'main';
  const { stdout: headStdout } = await execute(['rev-parse', 'HEAD']);
  const diffBase = await resolvePacketDiffBase(cwd, baseRef, headStdout.trim(), undefined, runGit);
  const { stdout: countStdout } = await execute(['rev-list', '--count', `${diffBase.comparisonRef}..HEAD`]);
  const commitsAhead = Number.parseInt(countStdout.trim(), 10);
  if (!Number.isFinite(commitsAhead)) {
    throw new Error(`Unable to parse git rev-list count: ${countStdout.trim() || '<empty>'}`);
  }

  const { stdout: statusStdout } = await execute(['status', '--porcelain']);
  const statusPorcelain = statusStdout.trim();

  return {
    commitsAhead,
    comparisonRef: diffBase.comparisonRef,
    statusPorcelain,
    noChangesProduced: commitsAhead === 0 && statusPorcelain.length === 0,
  };
}
