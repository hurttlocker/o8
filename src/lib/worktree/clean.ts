import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER = 8 * 1024 * 1024;

export async function resetTrackedWorkspaceChanges(cwd: string): Promise<void> {
  await execFileAsync('git', ['reset', '--hard', 'HEAD'], {
    windowsHide: true,
    cwd,
    timeout: 15_000,
    maxBuffer: COMMAND_MAX_BUFFER,
  });
}
