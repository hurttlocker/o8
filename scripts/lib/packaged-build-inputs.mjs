import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertTauriExportInputsSafe } from './tauri-export-safety.mjs';

// Run only on the isolated export, after Next has finished copying traced
// dependencies. Never prune the checkout or the standalone tracing inputs.
export function prunePackagedBuildInputs(serverRoot, platform = process.platform) {
  assertTauriExportInputsSafe(serverRoot);
  if (!lstatSync(serverRoot).isDirectory()) throw new Error('export must be a directory');
  const pruningRoots = [
    ['.next'], ['.next', 'types'],
    ...(platform === 'darwin' ? [
      ['node_modules', 'better-sqlite3'], ['node_modules', 'node-pty'],
      ['node_modules', 'node-pty', 'third_party', 'conpty'],
    ] : []),
  ];
  // Validate every ancestor before deleting anything. lstat on a leaf alone
  // follows intermediate links, including .next or third_party aliases.
  for (const parts of pruningRoots) {
    let directory = serverRoot;
    for (const part of parts) {
      directory = join(directory, part);
      if (lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error(`packaged pruning root has a symbolic link: ${parts.join('/')}`);
      }
    }
  }
  let removedFiles = 0;
  let removedBytes = 0;
  const removeFiles = (directory, select) => {
    if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) removeFiles(path, select);
      else if (entry.isFile() && select(entry.name)) {
        removedBytes += lstatSync(path).size;
        rmSync(path);
        removedFiles += 1;
      }
      // Do not follow links, including links to directories inside the export.
    }
  };
  removeFiles(join(serverRoot, '.next'), (name) => name.endsWith('.nft.json'));
  removeFiles(join(serverRoot, '.next', 'types'), () => true);
  if (platform === 'darwin') {
    for (const name of ['better-sqlite3', 'node-pty']) {
      removeFiles(join(serverRoot, 'node_modules', name), (file) => /\.(?:c|cc|cpp|h|hpp|gyp|gypi)$/.test(file));
    }
    removeFiles(join(serverRoot, 'node_modules', 'node-pty', 'third_party', 'conpty'), () => true);
  }
  return { removedFiles, removedBytes };
}
