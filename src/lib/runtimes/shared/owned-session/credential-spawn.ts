import { spawn, type ChildProcess } from 'node:child_process';
import { withProviderStoreLock } from '@/lib/providers/store-lock';
import { credentialPolicyFingerprint } from '@/lib/providers/credential-policy';
import { assertOwnedMcpArtifactAvailable } from '@/lib/providers/mcp-artifacts';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { guardedWorkspaceInvocation } from '@/lib/worktree/materialization-execution';
import { assertControlledLaunchGrantCurrent } from '@/lib/mcp/task-execution-admission';
import { ownedSpawnEnvironment } from './restricted-spawn-env';
import { assertOwnedActionAdmission } from './action-admission';
import type { OwnedSessionRecord } from './types';

export function assertLaunchCredentialPolicy(runtimeId: string, expected: string): void {
  if (credentialPolicyFingerprint(runtimeId) !== expected) throw new Error('Credentials or billing changed during launch preparation. Retry the launch.');
}

/** No await between the shared policy check and OS process creation. */
export function spawnCredentialCheckedChild(input: {
  session: OwnedSessionRecord; runtimeId: string; policy: string; runId: string;
  binary: string; args: string[]; env: Record<string, string>;
  stdinPayload: string | null; stdoutFd: number; stderrFd: number; mcpConfigPath?: string;
  materializationIdentity: Parameters<typeof guardedWorkspaceInvocation>[2];
}): ChildProcess {
  return withProviderStoreLock(() => {
    assertLaunchCredentialPolicy(input.runtimeId, input.policy);
    assertOwnedMcpArtifactAvailable(input.mcpConfigPath);
    const invocation = cliInvocation(input.binary, input.args);
    const launch = process.platform === 'win32'
      ? guardedWorkspaceInvocation(invocation.command, invocation.args, input.materializationIdentity)
      : guardedWorkspaceInvocation('/usr/bin/nice', ['-n', '10', input.binary, ...input.args], input.materializationIdentity);
    assertControlledLaunchGrantCurrent(input.session);
    assertOwnedActionAdmission(input.session, input.runId);
    return spawn(launch.command, launch.args, {
      windowsHide: true, cwd: input.session.repoPath, detached: true,
      stdio: [input.stdinPayload ? 'pipe' : 'ignore', input.stdoutFd, input.stderrFd],
      env: ownedSpawnEnvironment(input.session, input.env),
    });
  });
}
