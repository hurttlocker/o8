import type { ChildProcess } from 'node:child_process';
import { spawnWithWorkAdmission as spawn } from '@/lib/app-update/work-launch-admission';
import { bindDeferredCodexMcpLaunch } from '@/lib/providers/deferred-mcp-arguments';
import { withProviderStoreLock } from '@/lib/providers/store-lock';
import { credentialPolicyFingerprint } from '@/lib/providers/credential-policy';
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
  stdinFd?: number; stdoutFd: number; stderrFd: number; mcpConfigPath?: string;
  mcpServers?: readonly { name: string; env?: Record<string, string> }[];
  materializationIdentity: Parameters<typeof guardedWorkspaceInvocation>[2];
}): ChildProcess {
  return withProviderStoreLock(() => {
    assertLaunchCredentialPolicy(input.runtimeId, input.policy);
    const env = ownedSpawnEnvironment(input.session, input.env);
    const build = (args: string[]) => {
      const invocation = cliInvocation(input.binary, args);
      return process.platform === 'win32'
        ? guardedWorkspaceInvocation(invocation.command, invocation.args, input.materializationIdentity)
        : guardedWorkspaceInvocation('/usr/bin/nice', ['-n', '10', input.binary, ...args], input.materializationIdentity);
    };
    const launch = input.runtimeId === 'codex'
      ? bindDeferredCodexMcpLaunch(env, input.args, input.mcpServers ?? [], build) : build(input.args);
    assertControlledLaunchGrantCurrent(input.session);
    assertOwnedActionAdmission(input.session, input.runId);
    return spawn(launch.command, launch.args, {
      windowsHide: true, cwd: input.session.repoPath, detached: true,
      stdio: [input.stdinFd ?? 'ignore', input.stdoutFd, input.stderrFd],
      env,
    });
  });
}
