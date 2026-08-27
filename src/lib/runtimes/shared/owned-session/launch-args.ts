import { prepareOwnedWorkerMcpConfig, type PreparedOwnedWorkerMcpConfig } from './worker-mcp-config';
import type {
  OwnedRunMode,
  OwnedRuntimeAdapter,
  OwnedSessionRecord,
} from './types';

export interface PreparedOwnedLaunchArgs {
  args: string[];
  stdinPayload: string | null;
  workerMcp: PreparedOwnedWorkerMcpConfig;
}

export async function prepareOwnedLaunchArgs({
  adapter,
  session,
  runId,
  prompt,
  mode,
  sandboxEnabled,
  humanLabel,
}: {
  adapter: OwnedRuntimeAdapter;
  session: OwnedSessionRecord;
  runId: string;
  prompt: string;
  mode: OwnedRunMode;
  sandboxEnabled: boolean;
  humanLabel: string;
}): Promise<PreparedOwnedLaunchArgs> {
  const workerMcp: PreparedOwnedWorkerMcpConfig = mode === 'launch'
    || adapter.workerMcpInjection === 'config-override'
    ? await prepareOwnedWorkerMcpConfig({
        adapter,
        session,
        runId,
        mode,
        sandboxEnabled,
      })
    : { sandboxReadPaths: [], servers: [] };

  if (mode === 'launch') {
    return {
      args: adapter.launchArgs({
        cwd: session.repoPath,
        sessionDir: session.sessionDir,
        prompt,
        model: session.model,
        effort: session.effort,
        workerMcpConfigPath: workerMcp.configPath,
        workerMcpServers: workerMcp.servers,
      }),
      stdinPayload: adapter.launchStdin?.({
        cwd: session.repoPath,
        prompt,
        model: session.model,
        effort: session.effort,
      }) ?? null,
      workerMcp,
    };
  }

  const args = adapter.resumeArgs({
    threadId: session.threadId ?? '',
    sessionDir: session.sessionDir,
    prompt,
    model: session.model,
    workerMcpServers: workerMcp.servers,
  });
  if (!args) {
    throw new Error(`Resume is not supported by the ${humanLabel} runtime adapter.`);
  }
  return {
    args,
    stdinPayload: null,
    workerMcp,
  };
}
