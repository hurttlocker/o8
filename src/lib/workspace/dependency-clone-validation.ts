import { readFile, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

interface LockedPackage {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  optional?: boolean;
  os?: string[];
  cpu?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function permits(values: string[] | undefined, actual: string): boolean {
  return !values || (!values.includes(`!${actual}`)
    && (!values.some((value) => !value.startsWith('!')) || values.includes(actual)));
}

/** npm's installed lock is independent evidence of the installed resolution. */
export async function validateDependencyCloneGraph(workspace: string): Promise<boolean> {
  try {
    const read = async (relative: string) => JSON.parse(await readFile(path.join(workspace, relative), 'utf8')) as {
      lockfileVersion?: number; packages?: Record<string, LockedPackage>;
    };
    const [lock, installed] = await Promise.all([read('package-lock.json'), read('node_modules/.package-lock.json')]);
    if (installed.lockfileVersion !== 3 || !lock.packages || !installed.packages) return false;
    const inspectModules = async (relative: string): Promise<boolean> => {
      let entries;
      try { entries = await readdir(path.join(workspace, relative), { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isSymbolicLink()) return false;
        if (!entry.isDirectory()) continue;
        const name = `${relative}/${entry.name}`;
        if (entry.name.startsWith('@')) {
          if (!await inspectModules(name)) return false;
        } else {
          if (!installed.packages![name] || !await inspectModules(`${name}/node_modules`)) return false;
        }
      }
      return true;
    };
    if (!await inspectModules('node_modules')) return false;
    for (const [name, entry] of Object.entries(installed.packages)) {
      const wanted = lock.packages[name];
      if (!name || !wanted || entry.link || wanted.link
        || entry.version !== wanted.version || entry.resolved !== wanted.resolved
        || entry.integrity !== wanted.integrity) return false;
      const directory = await lstat(path.join(workspace, name));
      if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
      const manifest = JSON.parse(await readFile(path.join(workspace, name, 'package.json'), 'utf8')) as LockedPackage;
      if (manifest.version !== entry.version) return false;
    }
    const selected = (entry: LockedPackage) => permits(entry.os, process.platform) && permits(entry.cpu, process.arch);
    const resolve = (parent: string, name: string) => {
      let current = parent;
      for (;;) {
        const candidate = `${current ? `${current}/` : ''}node_modules/${name}`;
        if (lock.packages![candidate]) return candidate;
        if (!current) return null;
        current = current.includes('/node_modules/') ? current.slice(0, current.lastIndexOf('/node_modules/')) : '';
      }
    };
    // An omitted optional subtree is legitimate only when no selected installed
    // parent requires it. This includes dependencies of excluded platform packages.
    for (const [name, entry] of Object.entries(lock.packages)) {
      if (name && !installed.packages[name]) {
        if (!entry.optional && selected(entry)) return false;
        continue;
      }
      for (const dependency of Object.keys({
        ...entry.dependencies, ...entry.optionalDependencies,
        ...(name === '' ? entry.devDependencies : {}),
      })) {
        const resolved = resolve(name, dependency);
        if (!resolved || (selected(lock.packages[resolved]!) && !installed.packages[resolved])) return false;
      }
    }
    return true;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
