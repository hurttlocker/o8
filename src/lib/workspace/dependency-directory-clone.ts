import { lstat } from 'node:fs/promises';
import path from 'node:path';

import {
  assertWorktreeMaterializationIdentity,
  captureWorktreeMaterializationIdentity,
  type WorktreeMaterializationIdentity,
} from '@/lib/worktree/materialization-identity';
import { createPinnedWorkspaceBinding, readPinnedWorkspaceFile } from '@/lib/worktree/materialization-leaf-io';
import { guardedWorkspaceInvocation, materializationAwareExecFile } from '@/lib/worktree/materialization-execution';
import type { DependencyInstallOptions, DependencyInstallRecipe } from './dependency-install';
import { validateDependencyCloneGraph } from './dependency-clone-validation';
import { finishDependencyClone } from './dependency-clone-lifecycle';
import { profileDependencyClone as profile } from './dependency-clone-profile';

const CHECK_SOURCE_RECIPE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const recipe = JSON.parse(process.argv[1]);
const tree = require('node:child_process').spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {encoding:'utf8'});
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
  const disposition = await profile('directory-clone-publication', () => createPinnedWorkspaceBinding(workspace, identity, 'node_modules', {
    mode: 'clone-tree', source: sourcePath,
  }));
  if (disposition === 'unsupported') return false;
  if (disposition !== 'created') throw new Error('Dependency clone destination already exists.');
  await assertWorktreeMaterializationIdentity(sourceWorkspace, sourceIdentity);
  await assertWorktreeMaterializationIdentity(workspace, identity);
  if (!await profile('source-recipe-recheck', sourceMatches)) throw new Error('Dependency clone source recipe changed during materialization.');
  const target = await profile('target-manifests', () => validateDependencyCloneGraph(workspace));
  if (!target || target.digest !== graph.digest) throw new Error('Dependency clone installed graph changed.');
  await finishDependencyClone({ workspace, identity, recipe, options, nativeFiles: target.nativeFiles });
  await assertWorktreeMaterializationIdentity(workspace, identity);
  return true;
}
