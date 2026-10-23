import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { assertWorktreeMaterializationIdentity, captureWorktreeMaterializationIdentity, type WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { createPinnedWorkspaceBinding, readPinnedWorkspaceFile } from '@/lib/worktree/materialization-leaf-io';
import { guardedWorkspaceInvocation, materializationAwareExecFile } from '@/lib/worktree/materialization-execution';
import { auditPrivateDependencyView, type DependencyInstallOptions, type DependencyInstallRecipe } from './dependency-install';
import { validateDependencyCloneGraph } from './dependency-clone-validation';
import { finishDependencyClone } from './dependency-clone-lifecycle';

/** Reuse only the identical recipe; every resulting byte belongs to a new inode. */
export async function tryCloneDependencyDirectory(input: {
  sourceWorkspace: string;
  workspace: string;
  identity: WorktreeMaterializationIdentity;
  recipe: DependencyInstallRecipe;
  installCommand: string;
  options: DependencyInstallOptions;
}): Promise<boolean> {
  const { sourceWorkspace, workspace, identity, recipe, installCommand, options } = input;
  if (path.resolve(sourceWorkspace) === path.resolve(workspace)) return false;
  try {
    await lstat(path.join(workspace, 'node_modules'));
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Workspace/local links need the normal setup contract. Limit reuse to a
  // single npm dependency tree with the exact committed tree and recipe inputs.
  if (process.platform !== 'darwin' || recipe.packageManager !== 'npm'
    || recipe.platform !== process.platform || recipe.architecture !== process.arch
    || recipe.runtimeAbi !== process.versions.modules || recipe.installArgs[0] !== 'ci'
    || recipe.installArgs.some((arg) => arg.startsWith('--omit') || arg === '--production')
    || recipe.localDependencyDigests.length > 0
    || recipe.inputDigests.filter((entry) => entry.path.endsWith('package.json')).length !== 1) return false;
  const sourceIdentity = await captureWorktreeMaterializationIdentity(sourceWorkspace);
  const sourcePath = path.join(sourceWorkspace, 'node_modules');
  try {
    await lstat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const sourceMatches = async () => {
    const invocation = guardedWorkspaceInvocation('git', ['rev-parse', 'HEAD^{tree}'], sourceIdentity);
    const tree = await materializationAwareExecFile(invocation.command, invocation.args, {
      cwd: sourceWorkspace, timeout: 5000,
    });
    if (tree.stdout.trim() !== recipe.gitTreeSha) return false;
    for (const input of [...recipe.inputDigests, recipe.lockfile]) {
      const content = await readPinnedWorkspaceFile(sourceWorkspace, sourceIdentity, input.path);
      if (content === null || createHash('sha256').update(content).digest('hex') !== input.digest) return false;
    }
    return true;
  };
  if (!await sourceMatches()) return false;
  const manifest = JSON.parse((await readPinnedWorkspaceFile(workspace, identity, 'package.json'))!) as { workspaces?: unknown; scripts?: Record<string, unknown> };
  if (manifest.workspaces) return false;
  if (recipe.lifecycleScripts === 'enabled'
    && ['preinstall', 'install', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'dependencies'].some((stage) => manifest.scripts?.[stage])) return false;
  if (!await validateDependencyCloneGraph(sourceWorkspace)) return false;
  if (await readPinnedWorkspaceFile(workspace, identity, 'binding.gyp') !== null) return false;
  await auditPrivateDependencyView(sourceWorkspace);
  await assertWorktreeMaterializationIdentity(sourceWorkspace, sourceIdentity);
  const disposition = await createPinnedWorkspaceBinding(workspace, identity, 'node_modules', {
    mode: 'clone-tree', source: sourcePath,
  });
  if (disposition === 'unsupported') return false;
  if (disposition !== 'created') throw new Error('Dependency clone destination already exists.');
  await assertWorktreeMaterializationIdentity(sourceWorkspace, sourceIdentity);
  await assertWorktreeMaterializationIdentity(workspace, identity);
  if (!await sourceMatches()) {
    throw new Error('Dependency clone source recipe changed during materialization.');
  }
  if (!await validateDependencyCloneGraph(workspace)) throw new Error('Dependency clone installed graph changed.');
  const nativeFiles: string[] = [];
  await auditPrivateDependencyView(workspace, (file) => { if (file.endsWith('.node')) nativeFiles.push(file); });
  await finishDependencyClone({ workspace, identity, recipe, installCommand, options, nativeFiles });
  await assertWorktreeMaterializationIdentity(workspace, identity);
  return true;
}
