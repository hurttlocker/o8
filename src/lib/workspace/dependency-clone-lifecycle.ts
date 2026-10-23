import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { guardedWorkspaceInvocation, materializationAwareExecFile } from '@/lib/worktree/materialization-execution';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { runDependencyInstall, type DependencyInstallOptions, type DependencyInstallRecipe } from './dependency-install';

const ROOT_LIFECYCLE = ['preinstall', 'install', 'postinstall'];

/** Cloning installed packages does not replace workspace-local lifecycle output. */
export async function finishDependencyClone(input: {
  workspace: string;
  identity: WorktreeMaterializationIdentity;
  recipe: DependencyInstallRecipe;
  installCommand: string;
  options: DependencyInstallOptions;
  nativeFiles: string[];
}): Promise<void> {
  const { workspace, identity, recipe, installCommand, options, nativeFiles } = input;
  for (const file of nativeFiles) {
    const invocation = guardedWorkspaceInvocation(process.execPath, ['-e',
      "const Module=require('node:module'); process.dlopen(new Module(process.argv[1]),process.argv[1]);", file,
    ], identity);
    await materializationAwareExecFile(invocation.command, invocation.args, { cwd: workspace, timeout: 15_000 });
  }
  if (recipe.lifecycleScripts === 'disabled') return;
  const manifest = JSON.parse(await readFile(path.join(workspace, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
  const scripts = ROOT_LIFECYCLE.filter((stage) => typeof manifest.scripts?.[stage] === 'string');
  if (scripts.length === 0) return;
  await runDependencyInstall(workspace, installCommand, {
    ...options, preparedRecipe: recipe, materializationIdentity: identity,
    run: async (base) => {
      const invocation = { ...base, args: ['rebuild', '.', ...recipe.installArgs.slice(1)] };
      if (options.run) await options.run(invocation);
      else {
        const guarded = guardedWorkspaceInvocation(base.command, invocation.args, identity);
        await materializationAwareExecFile(guarded.command, guarded.args, {
          cwd: workspace, env: base.env, timeout: base.timeoutMs, maxBuffer: 8 * 1024 * 1024,
        });
      }
    },
  });
}
