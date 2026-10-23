import { chmodSync, closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, mkdirSync, readdirSync, writeFileSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { withProviderStoreLock } from './store-lock';

const artifactName = /^o8-worker-mcp-[a-zA-Z0-9-]+\.json$/;
const unsafe = () => new Error('Owned MCP credential artifacts are unavailable or unsafe; previous credential state preserved.');
function optionalStat(file: string): Stats | null {
  try { return lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw unsafe(); }
}
function directory(dir: string): Stats | null {
  const stat = optionalStat(dir);
  if (stat && (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))) throw unsafe();
  return stat;
}
const artifactDirectory = () => join(getDataDir(), 'worker-mcp-artifacts');

/** Called while holding .provider-keys.lock, in both Node and Rust before committing a mutation. */
export function purgeOwnedMcpArtifacts(): void {
  const files: number[] = [];
  const observed: { dir: string; stat: Stats }[] = [];
  let visited = 0;
  const entries = (dir: string) => {
    const stat = directory(dir); if (!stat) return [];
    observed.push({ dir, stat });
    const list = readdirSync(dir, { withFileTypes: true }).filter(entry =>
      !entry.isFile() || !artifactName.test(entry.name) || optionalStat(join(dir, entry.name))?.size !== 0);
    visited += list.length;
    if (visited > 100_000) throw unsafe();
    return list;
  };
  const collect = (dir: string) => {
    for (const entry of entries(dir)) if (artifactName.test(entry.name)) {
      const file = join(dir, entry.name); const stat = optionalStat(file);
      if (!stat?.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw unsafe();
      if (stat.size === 0) continue;
      const fd = openSync(file, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      files.push(fd);
      const opened = fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1) throw unsafe();
    }
  };
  try {
    collect(artifactDirectory());
    // Bounded migration of old per-session copies, including archived sessions.
    const roots = new Set<string>();
    const stableRoots: { dir: string; stat: Stats }[] = [];
    if (directory(getDataDir())) for (const entry of readdirSync(getDataDir(), { withFileTypes: true })) {
      if (/^owned-[a-z0-9-]+$/.test(entry.name)) roots.add(join(getDataDir(), entry.name));
    }
    for (const [name, value] of Object.entries(process.env)) if (/^(?:O8|CORTEX_IDE)_OWNED_[A-Z0-9_]+_ROOT$/.test(name) && value) {
      if (!isAbsolute(value)) throw unsafe();
      roots.add(resolve(value)); roots.add(`${resolve(value).replace(/\/+$/, '')}-archive`);
    }
    for (const root of roots) {
      const stat = directory(root); if (stat) stableRoots.push({ dir: root, stat });
      for (const entry of entries(root)) {
        if (entry.isSymbolicLink()) throw unsafe();
        if (entry.isDirectory()) collect(join(root, entry.name));
      }
    }
    for (const { dir, stat } of observed) {
      const current = directory(dir);
      if (!current || current.dev !== stat.dev || current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) throw unsafe();
    }
    // Open handles cannot follow a parent directory replaced after validation.
    for (const fd of files) ftruncateSync(fd, 0);
    for (const { dir, stat } of stableRoots) {
      const current = directory(dir);
      if (!current || current.dev !== stat.dev || current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) throw unsafe();
    }
  } finally { for (const fd of files) closeSync(fd); }
}

export function writeOwnedMcpArtifact(runtimeId: string, runId: string, contents: string, assertCurrent: () => void): string {
  if (!/^[a-z0-9-]+$/.test(runtimeId) || !/^[a-zA-Z0-9-]+$/.test(runId)) throw unsafe();
  return withProviderStoreLock(() => {
    assertCurrent();
    directory(getDataDir()); directory(artifactDirectory());
    mkdirSync(artifactDirectory(), { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(artifactDirectory(), 0o700);
    const active = readdirSync(artifactDirectory()).filter(name => artifactName.test(name) && optionalStat(join(artifactDirectory(), name))?.size !== 0);
    if (active.length >= 10_000) throw unsafe();
    const file = join(artifactDirectory(), `o8-worker-mcp-${runtimeId}-${runId}.json`);
    writeFileSync(file, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return file;
  });
}

export function assertOwnedMcpArtifactAvailable(file: string | undefined): void {
  if (!file) return;
  if (!directory(artifactDirectory()) || dirname(file) !== artifactDirectory() || !artifactName.test(basename(file))) throw unsafe();
  const stat = optionalStat(file);
  if (!stat?.isFile() || stat.size === 0 || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw unsafe();
}
