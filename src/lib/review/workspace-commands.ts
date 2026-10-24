import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import { createWorkspaceGitHubReader } from './github-reads';

const execFileAsync = promisify(execFile);

export function createWorkspaceReviewCommands(repoRoot: string, warnings: string[]) {
  const runInContext = async (command: string, args: string[], env = process.env) => {
    const { stdout } = await execFileAsync(command, args, {
      windowsHide: true,
      cwd: repoRoot,
      env: { ...env, LC_ALL: 'C' },
      timeout: command === 'gh' ? args[0] === 'auth' ? 3_000 : 15_000 : undefined,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  };
  const readGitHub = createWorkspaceGitHubReader(repoRoot, (args, env) => runInContext('gh', args, env));
  const tryRunInContext = async (command: string, args: string[]) => {
    if (command === 'gh') {
      const result = await readGitHub(args);
      if (result.warning && !warnings.includes(result.warning)) warnings.push(result.warning);
      return result.raw;
    }
    try { return await runInContext(command, args); }
    catch { return ''; }
  };
  return { runInContext, tryRunInContext };
}
