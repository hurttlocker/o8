import { assertOrchestratorRepoPath } from '@/lib/lane/repo-preflight';
import { formatMissingCliError } from '@/lib/runtimes/shared/cli-unavailable';
import { CliNotFoundError, resolveCli } from '@/lib/runtimes/shared/cli-resolver';

export async function resolveOpenclawSpawnBinary(repoPath: string): Promise<string> {
  assertOrchestratorRepoPath(repoPath);
  const cliSpec = {
    runtimeId: 'openclaw',
    binaryName: 'openclaw',
    humanLabel: 'OpenClaw',
    envOverride: 'O8_OPENCLAW_BIN',
  };
  try {
    return (await resolveCli(cliSpec)).path;
  } catch (error) {
    if (!(error instanceof CliNotFoundError)) throw error;
    throw new Error(formatMissingCliError({
      ...cliSpec,
      triedPaths: error.triedPaths,
    }));
  }
}
