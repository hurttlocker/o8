import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { dependencyCloneSnapshot } from './dependency-clone-snapshot';

export interface NativePackageMetadata {
  hasInstallScript?: boolean;
  os?: string[];
  cpu?: string[];
  gypfile?: boolean;
  binary?: unknown;
  napi?: unknown;
  main?: string;
  exports?: unknown;
  files?: unknown;
  scripts?: Record<string, unknown>;
}

function declaredNative(value: unknown): string[] {
  if (typeof value === 'string') return value.endsWith('.node') ? [value] : [];
  return value && typeof value === 'object' ? Object.values(value).flatMap(declaredNative) : [];
}

function foreignPrebuild(relative: string): boolean {
  const parts = relative.split('/');
  return parts.some((part, index) => {
    if (!['prebuilds', 'native'].includes(parts[index - 1] ?? '')) return false;
    const selected = /^(darwin|linux|win32|freebsd|android)(?:-([\w]+))?$/.exec(part);
    return selected && (selected[1] !== process.platform || (selected[2] && selected[2] !== process.arch));
  });
}

/** Only metadata-identified native packages need a recursive binary inventory. */
export async function dependencyCloneNativeFiles(input: {
  workspace: string;
  name: string;
  lockNative: boolean;
  manifest: NativePackageMetadata;
  capture: ReturnType<typeof dependencyCloneSnapshot>;
}): Promise<string[]> {
  const { workspace, name, lockNative, manifest, capture } = input;
  const root = path.join(workspace, name);
  const entries = await readdir(root, { withFileTypes: true });
  const declared = [...declaredNative(manifest.main), ...declaredNative(manifest.exports)];
  const hinted = lockNative || manifest.os || manifest.cpu || manifest.gypfile || manifest.binary || manifest.napi
    || ['preinstall', 'install', 'postinstall'].some((stage) => manifest.scripts?.[stage])
    || JSON.stringify(manifest.files ?? []).match(/\.node|binding\.gyp|prebuilds|native/)
    || entries.some((entry) => entry.name.endsWith('.node') || ['binding.gyp', 'prebuilds', 'native'].includes(entry.name));
  const native = new Set<string>();
  const add = async (relative: string) => {
    const entry = await capture.record(relative);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Native dependency is not a regular private file.');
    const canonical = await realpath(path.join(workspace, relative));
    const contained = path.relative(await realpath(root), canonical);
    if (contained === '..' || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) {
      throw new Error('Native dependency escapes its package.');
    }
    native.add(relative);
  };
  for (const target of declared) {
    if (path.isAbsolute(target) || target.split('/').includes('..')) throw new Error('Unsafe native dependency declaration.');
    if (!target.includes('*')) await add(path.join(name, target));
  }
  if (hinted || declared.length) {
    const visit = async (relative: string): Promise<void> => {
      const directory = await capture.record(path.join(name, relative));
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Native dependency directory changed.');
      for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
        const next = path.posix.join(relative, entry.name);
        if (entry.name === 'node_modules' || foreignPrebuild(next)) continue;
        if (entry.name.endsWith('.node')) await add(path.join(name, next));
        else if (entry.isDirectory()) await visit(next);
        else if (entry.name === 'binding.gyp') await capture.record(path.join(name, next));
      }
    };
    await visit('');
  }
  return [...native].sort();
}
