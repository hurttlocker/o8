import { guardedWorkspaceInvocation, materializationAwareExecFile } from '@/lib/worktree/materialization-execution';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import type { DependencyInstallRecipe } from './dependency-install';
import { RECIPE_CONFIG_NAMES } from './dependency-manager-config';

const CHECK_SOURCE_RECIPE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const {recipe, configNames, sourceTree, requireSameTree} = JSON.parse(process.argv[1]);
const git = (...args) => cp.execFileSync('git', args, {encoding:'utf8'}).trim();
const tree = git('rev-parse', 'HEAD^{tree}');
let matches = (!sourceTree || tree === sourceTree) && (!requireSameTree || tree === recipe.gitTreeSha);
const tracked = cp.execFileSync('git', ['ls-files', '-z'], {encoding:'utf8'}).split('\0').filter(Boolean);
const inputs = tracked.filter(file => path.posix.basename(file) === 'package.json'
  || configNames.includes(file) || file.startsWith('patches/') || file.startsWith('.yarn/patches/')
  || file.startsWith('.yarn/plugins/') || file.startsWith('.yarn/releases/') || file.endsWith('.patch')
  || (recipe.cloneLifecycleInputs || []).includes(file));
matches = matches && JSON.stringify(inputs.sort()) === JSON.stringify(recipe.inputDigests.map(input => input.path).sort());
for (const config of [...configNames, 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
  if (!recipe.inputDigests.some(input => input.path === config) && recipe.lockfile.path !== config) {
    try { fs.lstatSync(config); matches = false; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
if (matches) for (const input of [...recipe.inputDigests, recipe.lockfile]) {
  if (path.isAbsolute(input.path) || input.path.split('/').includes('..')) throw new Error('Unsafe dependency recipe input.');
  const parts = input.path.split('/'); parts.pop();
  let ancestor = '.';
  for (const part of parts) {
    ancestor = path.join(ancestor, part);
    const entry = fs.lstatSync(ancestor);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe dependency recipe ancestor.');
  }
  const fd = fs.openSync(input.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Unsafe dependency recipe input.');
    matches = matches && crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex') === input.digest;
  } finally { fs.closeSync(fd); }
}
matches = matches && git('rev-parse', 'HEAD^{tree}') === tree;
console.log(JSON.stringify({matches, tree}));
`;

/** Compare dependency inputs, retaining the donor's own tree as the race fence. */
export function dependencyCloneSourceMatcher(sourceWorkspace: string, identity: WorktreeMaterializationIdentity, recipe: DependencyInstallRecipe, requireSameTree: boolean) {
  let sourceTree: string | undefined;
  return async () => {
    const invocation = guardedWorkspaceInvocation(process.execPath, ['-e', CHECK_SOURCE_RECIPE,
      JSON.stringify({ recipe, configNames: [...RECIPE_CONFIG_NAMES], sourceTree, requireSameTree }),
    ], identity);
    const result = await materializationAwareExecFile(invocation.command, invocation.args, { cwd: sourceWorkspace, timeout: 10_000 });
    const check = JSON.parse(result.stdout) as { matches: boolean; tree: string };
    sourceTree ??= check.tree;
    return check.matches;
  };
}
