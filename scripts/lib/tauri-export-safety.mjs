import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

export function assertTauriExportInputsSafe(standaloneRoot) {
  for (const [label, path] of [
    ['standalone build', standaloneRoot],
    ['standalone node_modules', join(standaloneRoot, 'node_modules')],
  ]) {
    if (!existsSync(path)) continue;
    if (!lstatSync(path).isSymbolicLink()) continue;
    throw new Error(
      `${label} is a symbolic link (${path}); install dependencies inside this worktree and rebuild before packaging`,
    );
  }

  const cache = join(standaloneRoot, '.next', 'cache');
  // lstat also catches dangling links. Never silently package or delete a
  // traced cache: reject before the exporter clears its previous output.
  if (lstatSync(cache, { throwIfNoEntry: false })) {
    throw new Error('standalone build contains .next/cache; exclude build cache from tracing and rebuild before packaging');
  }
}
