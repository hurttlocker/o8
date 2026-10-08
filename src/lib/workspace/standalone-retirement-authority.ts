import { createHash } from 'node:crypto';
import path from 'node:path';

import { listLanes } from '@/lib/lane/registry';
import { materializationAwareExecFile, withWorktreeMaterializationExecution } from '@/lib/worktree/materialization-execution';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { readWorktreeMetaSnapshot } from '@/lib/worktree/metadata-store';
import { canonicalRepoRoot } from '@/lib/worktree/root-layout';
import { MANAGED_WORKSPACE_SAFETY_SETTINGS, managedWorkspaceSafetyHooksContent, resolveManagedWorkspaceSafetyHookRuntime } from '@/lib/worktree/safety-hooks';
import { captureIgnoredArtifacts } from './ignored-artifact-io';

const REBUILDABLE_PATHS = ['node_modules', '.o8-install-runtime', '.next/cache', '.turbo'];

async function git(cwd: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  const { stdout } = await materializationAwareExecFile('git', args, {
    cwd, env, windowsHide: true, timeout: 20_000, maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

async function assertStandaloneOwner(repositoryPath: string, worktreeId: string, sourcePath: string, identity: WorktreeMaterializationIdentity): Promise<void> {
  const metadata = (await readWorktreeMetaSnapshot(repositoryPath))[worktreeId];
  if (!metadata || metadata.claudeManaged || metadata.status !== 'ready' || metadata.sessionKey
    || metadata.materializationIdentity?.device !== identity.device
    || metadata.materializationIdentity.inode !== identity.inode
    || metadata.materializationIdentity.canonicalPath !== sourcePath
    || !metadata.materializationParentIdentity
    || path.join(metadata.materializationParentIdentity.canonicalPath, worktreeId) !== sourcePath
    || listLanes().some((lane) => lane.worktreePath && (path.resolve(lane.worktreePath) === sourcePath
      || (path.basename(lane.worktreePath) === worktreeId && canonicalRepoRoot(lane.repoPath) === canonicalRepoRoot(repositoryPath))))) {
    throw new Error('Standalone cleanup requires exact ready manager ownership without a worker or packet lane.');
  }
}

async function verifyCleanContents(candidatePath: string, identity: WorktreeMaterializationIdentity, headCommit: string, treeSha: string, generatedSettingsSha256: string): Promise<void> {
  const capture = await captureIgnoredArtifacts({
    workspacePath: candidatePath, identity: { ...identity, canonicalPath: candidatePath },
    headCommit, treeSha, rebuildablePaths: REBUILDABLE_PATHS,
    copiedEnvironment: { [MANAGED_WORKSPACE_SAFETY_SETTINGS]: generatedSettingsSha256 },
  });
  if (capture.entries.some((entry) => entry.kind === 'file')) throw new Error('Standalone workspace has unique ignored content and must remain retained.');
}

/** Ready standalone workspaces may retire only clean content anchored in the source repository. */
export async function admitStandaloneRetirement(input: {
  repositoryPath: string; worktreeId: string; directoryPath: string; identity: WorktreeMaterializationIdentity;
}): Promise<Record<string, unknown>> {
  await assertStandaloneOwner(input.repositoryPath, input.worktreeId, input.directoryPath, input.identity);
  const [headCommit, treeSha] = await withWorktreeMaterializationExecution(input.directoryPath, input.identity, () => Promise.all([
    git(input.directoryPath, ['rev-parse', '--verify', 'HEAD^{commit}']),
    git(input.directoryPath, ['rev-parse', '--verify', 'HEAD^{tree}']),
  ]));
  const generatedSettingsSha256 = createHash('sha256').update(managedWorkspaceSafetyHooksContent(
    await resolveManagedWorkspaceSafetyHookRuntime(),
  )).digest('hex');
  await verifyCleanContents(input.directoryPath, input.identity, headCommit, treeSha, generatedSettingsSha256);
  const repositoryPath = canonicalRepoRoot(input.repositoryPath);
  const objects = await git(repositoryPath, ['rev-list', '--objects', '--missing=print', headCommit]);
  if (objects.split('\n').some((line) => line.startsWith('?'))) throw new Error('Standalone source recovery objects are incomplete.');
  const key = createHash('sha256').update(JSON.stringify({ repositoryPath, worktreeId: input.worktreeId, identity: input.identity, headCommit })).digest('hex');
  const recoveryRef = 'refs/o8/recovery/standalone/' + key;
  await git(repositoryPath, ['update-ref', recoveryRef, headCommit]);
  return { retirementReason: 'standalone-clean', repositoryPath, worktreeId: input.worktreeId, headCommit, treeSha, recoveryRef, generatedSettingsSha256 };
}

export async function verifyStandaloneRetirement(input: {
  authority: Record<string, unknown>; sourcePath: string; candidatePath: string;
  identity: WorktreeMaterializationIdentity; verifyContents: boolean;
}): Promise<void> {
  const { repositoryPath, worktreeId, headCommit, treeSha, recoveryRef, generatedSettingsSha256 } = input.authority;
  if (typeof repositoryPath !== 'string' || typeof worktreeId !== 'string'
    || typeof headCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(headCommit)
    || typeof treeSha !== 'string' || !/^[a-f0-9]{40,64}$/.test(treeSha)
    || typeof recoveryRef !== 'string' || !/^refs\/o8\/recovery\/standalone\/[a-f0-9]{64}$/.test(recoveryRef)
    || typeof generatedSettingsSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(generatedSettingsSha256)) {
    throw new Error('Standalone retirement lost its durable clean-content authority.');
  }
  await assertStandaloneOwner(repositoryPath, worktreeId, input.sourcePath, input.identity);
  if (await git(repositoryPath, ['rev-parse', '--verify', recoveryRef]) !== headCommit
    || await git(repositoryPath, ['rev-parse', '--verify', headCommit + '^{tree}']) !== treeSha) {
    throw new Error('Standalone retirement recovery anchor changed.');
  }
  if ((await git(repositoryPath, ['rev-list', '--objects', '--missing=print', headCommit]))
    .split('\n').some((line) => line.startsWith('?'))) throw new Error('Standalone recovery objects became incomplete.');
  if (input.verifyContents) await verifyCleanContents(input.candidatePath, input.identity, headCommit, treeSha, generatedSettingsSha256);
}
