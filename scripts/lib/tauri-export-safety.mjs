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
}
