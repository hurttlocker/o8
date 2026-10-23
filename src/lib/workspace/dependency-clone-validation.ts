import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, lstat, readdir, realpath } from 'node:fs/promises';
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
export async function validateDependencyCloneGraph(workspace: string): Promise<{ digest: string; nativeFiles: string[] } | null> {
  try {
    const read = async (relative: string) => JSON.parse(await readFile(path.join(workspace, relative), 'utf8')) as {
      lockfileVersion?: number; packages?: Record<string, LockedPackage>;
    };
    const [lock, installed] = await Promise.all([read('package-lock.json'), read('node_modules/.package-lock.json')]);
    if (installed.lockfileVersion !== 3 || !lock.packages || !installed.packages) return null;
    const inspectModules = async (relative: string): Promise<boolean> => {
      let entries;
      try {
        const directory = await lstat(path.join(workspace, relative));
        if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
        entries = await readdir(path.join(workspace, relative), { withFileTypes: true });
      }
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
    if (!await inspectModules('node_modules')) return null;
    const hash = createHash('sha256').update(JSON.stringify(installed));
    const nativeFiles: string[] = [];
    const canonicalRoot = await realpath(workspace);
    const contained = (target: string) => { const relative = path.relative(canonicalRoot, target); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
    const bins = new Set<string>();
    for (const [name, entry] of Object.entries(installed.packages)) {
      const wanted = lock.packages[name];
      if (!name || !wanted || entry.link || wanted.link
        || entry.version !== wanted.version || entry.resolved !== wanted.resolved
        || entry.integrity !== wanted.integrity) return null;
      if (!/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(name) || name.split('/').includes('..')) return null;
      const directory = await lstat(path.join(workspace, name));
      if (!directory.isDirectory() || directory.isSymbolicLink()) return null;
      const handle = await open(path.join(workspace, name, 'package.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: string;
      try { bytes = await handle.readFile('utf8'); } finally { await handle.close(); }
      hash.update(name).update(bytes);
      const manifest = JSON.parse(bytes) as LockedPackage & { bin?: string | Record<string, string>; main?: string; exports?: unknown };
      if (manifest.version !== entry.version) return null;
      for (const target of typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {})) {
        const bin = await realpath(path.join(workspace, name, target));
        if (!contained(bin)) return null;
        bins.add(bin);
      }
      const declaredNative = (value: unknown): string[] => {
        if (typeof value === 'string') return value.endsWith('.node') ? [value] : [];
        return value && typeof value === 'object' ? Object.values(value).flatMap(declaredNative) : [];
      };
      for (const target of [...declaredNative(manifest.main), ...declaredNative(manifest.exports)]) {
        if (target.includes('*') || path.isAbsolute(target) || target.split('/').includes('..')) return null;
        const relative = path.join(name, target);
        const entry = await lstat(path.join(workspace, relative));
        if (!entry.isFile() || !contained(await realpath(path.join(workspace, relative)))) return null;
        nativeFiles.push(relative);
      }
      // Inspect package metadata and conventional native output directories only;
      // never recurse through JS/assets. Other platforms' prebuilds are irrelevant.
      for (const directory of ['.', 'build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`,
        `native/${process.platform}/prebuilds/${process.platform}-${process.arch}`, ...(entry.os || entry.cpu ? ['lib'] : [])]) {
        let entries;
        try { entries = await readdir(path.join(workspace, name, directory), { withFileTypes: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        for (const file of entries) {
          if (!file.name.endsWith('.node')) continue;
          const relative = path.join(name, directory, file.name);
          if (!file.isFile() || !contained(await realpath(path.join(workspace, relative)))) return null;
          nativeFiles.push(relative);
        }
      }
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
        if (!entry.optional && selected(entry)) return null;
        continue;
      }
      for (const dependency of Object.keys({
        ...entry.dependencies, ...entry.optionalDependencies,
        ...(name === '' ? entry.devDependencies : {}),
      })) {
        const resolved = resolve(name, dependency);
        if (!resolved || (selected(lock.packages[resolved]!) && !installed.packages[resolved])) return null;
      }
    }
    // npm creates executable links from the installed package manifests. A
    // clone may retain those contained relative links, never links to the donor.
    const checkBins = async (relative: string) => {
      let entries;
      try {
        const directory = await lstat(path.join(workspace, relative));
        if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
        entries = await readdir(path.join(workspace, relative), { withFileTypes: true });
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
      for (const file of entries) {
        if (!file.isSymbolicLink() || !bins.has(await realpath(path.join(workspace, relative, file.name)))) return false;
      }
      return true;
    };
    for (const relative of new Set(['node_modules/.bin', ...Object.keys(installed.packages).map((name) => `${name}/node_modules/.bin`)])) {
      if (!await checkBins(relative)) return null;
    }
    const native = [...new Set(nativeFiles)].sort();
    return { digest: hash.update(JSON.stringify(native)).digest('hex'), nativeFiles: native };
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
