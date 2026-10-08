import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

export function assertTauriExportInputsSafe(standaloneRoot) {
  for (const [label, path] of [
    ['standalone build', standaloneRoot],
    ['standalone node_modules', join(standaloneRoot, 'node_modules')],
  ]) {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (!entry?.isSymbolicLink()) continue;
    throw new Error(
      `${label} is a symbolic link (${path}); install dependencies inside this worktree and rebuild before packaging`,
    );
  }

  // Next's standalone tracer may copy a nested dependency link from a
  // worktree install. Such a link can resolve on the build host while the
  // signed app is missing the dependency entirely.
  const modules = join(standaloneRoot, 'node_modules');
  if (lstatSync(modules, { throwIfNoEntry: false })?.isDirectory()) {
    const pending = [modules];
    while (pending.length > 0) {
      const directory = pending.pop();
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(path);
        } else if (entry.isSymbolicLink()) {
          let resolved;
          try {
            resolved = realpathSync(path);
          } catch {
            throw new Error(`dependency link is dangling: ${relative(standaloneRoot, path)}`);
          }
          const destination = relative(standaloneRoot, resolved);
          if (destination === '..' || destination.startsWith(`..${sep}`) || isAbsolute(destination)) {
            throw new Error(`dependency link escapes the package: ${relative(standaloneRoot, path)}`);
          }
        }
      }
    }
  }

  // lstat also catches dangling links. Never silently package or delete a
  // traced cache, development tree or profiling log: reject before clearing
  // previous output. Runtime manifests and per-route tracing metadata remain.
  for (const entry of ['cache', 'dev', 'trace', 'trace-build']) {
    const generated = join(standaloneRoot, '.next', entry);
    if (lstatSync(generated, { throwIfNoEntry: false })) {
      throw new Error(`standalone build contains .next/${entry}; exclude build-only files from tracing and rebuild before packaging`);
    }
  }
}
