import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER = 10 * 1024 * 1024;

export interface NoChangesProducedProbe {
  commitsAhead: number;
  statusPorcelain: string;
  noChangesProduced: boolean;
}

export async function probeNoChangesProduced(
  cwd: string,
  baseBranch: string,
): Promise<NoChangesProducedProbe> {
  const baseRef = baseBranch.trim() || 'main';
  const { stdout: countStdout } = await execFileAsync(
    'git',
    ['rev-list', '--count', `${baseRef}..HEAD`],
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
    statusPorcelain,
    noChangesProduced: commitsAhead === 0 && statusPorcelain.length === 0,
  };
}
