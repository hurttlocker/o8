import {
  runReceiptedDependencyCommand,
  type DependencyInstallOptions,
  type DependencyInstallRecipe,
} from './dependency-install';

export async function replayDependencyLifecycle(
  workspacePath: string,
  recipe: DependencyInstallRecipe,
  options: DependencyInstallOptions = {},
): Promise<void> {
  if (recipe.packageManager !== 'npm'
    || recipe.installArgs[0] !== 'ci'
    || recipe.lifecycleScripts !== 'enabled') {
    throw new Error('Dependency lifecycle replay requires an enabled npm ci recipe.');
  }
  await runReceiptedDependencyCommand(workspacePath, recipe, ['rebuild'], options);
}
