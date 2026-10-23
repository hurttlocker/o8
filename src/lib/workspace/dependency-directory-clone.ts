import { EMBEDDED_CHILD_POLICY_SCRIPT } from '@/lib/providers/embedded-child-policy';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import {
  assertWorktreeMaterializationIdentity,
  captureWorktreeMaterializationIdentity,
  type WorktreeMaterializationIdentity,
} from '@/lib/worktree/materialization-identity';
import { clonePinnedWorkspaceDirectory, readPinnedWorkspaceFile } from '@/lib/worktree/materialization-leaf-io';
import { guardedWorkspaceInvocation, materializationAwareExecFile } from '@/lib/worktree/materialization-execution';
import type { DependencyInstallOptions, DependencyInstallRecipe } from './dependency-install';
import { validateDependencyCloneGraph } from './dependency-clone-validation';
import { finishDependencyClone, probeDependencyCloneNativeFiles } from './dependency-clone-lifecycle';
import { purgeExactDirectory } from './exact-directory-purge';
import { dependencyCloneSnapshotMatches } from './dependency-clone-snapshot';
import { profileDependencyClone as profile } from './dependency-clone-profile';

const CHECK_SOURCE_RECIPE = EMBEDDED_CHILD_POLICY_SCRIPT + String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const recipe = JSON.parse(process.argv[1]);
const tree = withO8ChildPolicy(env => require('node:child_process').spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {env, encoding:'utf8'}));
let matches = tree.status === 0 && tree.stdout.trim() === recipe.gitTreeSha;
for (const input of [...recipe.inputDigests, recipe.lockfile]) {
  if (path.isAbsolute(input.path) || input.path.split('/').includes('..')) throw new Error('Unsafe dependency recipe input.');
  const parts = input.path.split('/');
  parts.pop();
  let ancestor = '.';
  for (const part of parts) {
    ancestor = path.join(ancestor, part);
    const entry = fs.lstatSync(ancestor);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe dependency recipe ancestor.');
  }
  const fd = fs.openSync(input.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { matches = matches && crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex') === input.digest; }
  finally { fs.closeSync(fd); }
}
console.log(JSON.stringify(matches));
`;

/** Clone a trusted installed npm tree; validate its recipe/metadata, not payload bytes. */
export async function tryCloneDependencyDirectory(input: {
  sourceWorkspace: string;
  afterClone?: () => Promise<void>;
  workspace: string;
  identity: WorktreeMaterializationIdentity;
  recipe: DependencyInstallRecipe;
  options: DependencyInstallOptions;
}): Promise<boolean> {
  const { sourceWorkspace, workspace, identity, recipe, options } = input;
  if (path.resolve(sourceWorkspace) === path.resolve(workspace)) return false;
  try { await lstat(path.join(workspace, 'node_modules')); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (process.platform !== 'darwin' || recipe.packageManager !== 'npm'
    || recipe.platform !== process.platform || recipe.architecture !== process.arch
    || recipe.runtimeAbi !== process.versions.modules || recipe.installArgs[0] !== 'ci'
    || recipe.installArgs.some((arg) => arg.startsWith('--omit') || arg === '--production')
    || recipe.localDependencyDigests.length > 0) return false;
  const sourceIdentity = await captureWorktreeMaterializationIdentity(sourceWorkspace);
  const sourcePath = path.join(sourceWorkspace, 'node_modules');
  try { await lstat(sourcePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  const sourceMatches = async () => {
    const invocation = guardedWorkspaceInvocation(process.execPath, ['-e', CHECK_SOURCE_RECIPE, JSON.stringify(recipe)], sourceIdentity);
    const result = await materializationAwareExecFile(invocation.command, invocation.args, { cwd: sourceWorkspace, timeout: 10_000 });
    return JSON.parse(result.stdout) === true;
  };
  if (!await profile('source-recipe', sourceMatches)) return false;
  const manifest = JSON.parse((await readPinnedWorkspaceFile(workspace, identity, 'package.json'))!) as { workspaces?: unknown; scripts?: Record<string, unknown> };
  if (manifest.workspaces) return false;
  if (recipe.lifecycleScripts === 'enabled'
    && ['preinstall', 'install', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'dependencies'].some((stage) => manifest.scripts?.[stage])) return false;
  const graph = await profile('source-manifests', () => validateDependencyCloneGraph(sourceWorkspace));
  if (!graph || await readPinnedWorkspaceFile(workspace, identity, 'binding.gyp') !== null) return false;
  await assertWorktreeMaterializationIdentity(sourceWorkspace, sourceIdentity);
  const clone = await profile('directory-clone-publication', () => clonePinnedWorkspaceDirectory(workspace, identity, 'node_modules', sourcePath));
  if (clone.disposition === 'unsupported') return false;
  if (clone.disposition !== 'created') throw new Error('Dependency clone destination already exists.');
  const discard = async () => {
    await assertWorktreeMaterializationIdentity(workspace, identity);
    await purgeExactDirectory(path.join(workspace, 'node_modules'), clone);
    await assertWorktreeMaterializationIdentity(workspace, identity);
    return false;
  };
  await input.afterClone?.();
  await assertWorktreeMaterializationIdentity(sourceWorkspace, sourceIdentity);
  await assertWorktreeMaterializationIdentity(workspace, identity);
  const sourceUnchanged = async () => await dependencyCloneSnapshotMatches(sourceWorkspace, graph.snapshot) && await sourceMatches();
  if (clone.sourceChanged || !await profile('source-recipe-recheck', sourceUnchanged)) return discard();
  const target = await profile('target-manifests', () => validateDependencyCloneGraph(workspace));
  if (!target || target.digest !== graph.digest) throw new Error('Dependency clone installed graph changed.');
  await finishDependencyClone({ workspace, identity, recipe, options });
  const final = await profile('final-manifests', () => validateDependencyCloneGraph(workspace));
  if (!final) throw new Error('Dependency clone lifecycle changed its installed graph.');
  await probeDependencyCloneNativeFiles(workspace, identity, final.nativeFiles);
  if (!await dependencyCloneSnapshotMatches(workspace, final.snapshot)) throw new Error('Dependency clone changed during native validation.');
  if (!await profile('source-final-recheck', sourceUnchanged)) throw new Error('Dependency clone source changed after lifecycle; refusing to replay setup.');
  await assertWorktreeMaterializationIdentity(workspace, identity);
  return true;
}
