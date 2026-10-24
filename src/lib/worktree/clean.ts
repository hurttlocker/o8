import { resolveGitBinary } from '@/lib/git/binary';
import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER = 8 * 1024 * 1024;

export async function resetTrackedWorkspaceChanges(cwd: string): Promise<void> {
  await execFileAsync(resolveGitBinary(), ['reset', '--hard', 'HEAD'], {
    windowsHide: true,
    cwd,
    timeout: 15_000,
    maxBuffer: COMMAND_MAX_BUFFER,
  });
}
