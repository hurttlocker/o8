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

  // lstat also catches dangling links. Never silently package or delete a
  // traced cache or development tree: reject before clearing previous output.
  for (const directory of ['cache', 'dev']) {
    const generated = join(standaloneRoot, '.next', directory);
    if (lstatSync(generated, { throwIfNoEntry: false })) {
      throw new Error(`standalone build contains .next/${directory}; exclude build-only files from tracing and rebuild before packaging`);
    }
  }
}
