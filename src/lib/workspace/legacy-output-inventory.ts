import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, opendir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertWorktreeMaterializationIdentity, type WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { GENERATED_BANK_LIMITS, type GeneratedOutputContentEntry } from './generated-output-bank';

/** Link nodes belong only to intact legacy relocation, never a file bank or disposal. */
export type LegacyOutputEntry = GeneratedOutputContentEntry | (Omit<GeneratedOutputContentEntry, 'kind'> & {
  kind: 'symlink';
  rawTarget: string;
});
interface Location {
  workspace: WorktreeMaterializationIdentity;
  candidate: WorktreeMaterializationIdentity;
}
const retainedName = /^\.o8-retained-legacy-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const generatedLink = /^dev\/node_modules\/(?:(@[a-z0-9][a-z0-9._-]*)\/)?([a-z0-9][a-z0-9._-]*)-[a-f0-9]{16}$/;
const linkBytesLimit = 4096;

function safeRelative(relative: string): void {
  if (relative === '.') return;
  const parts = relative.split('/');
  if (!relative || relative.length > 4096 || /[\\\x00-\x1f\x7f]/.test(relative)
    || path.isAbsolute(relative) || parts.length > 128 || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('Legacy inventory has an unsafe relative path.');
  }
}
function stable(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink
    && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
async function location(input: Location): Promise<void> {
  const { workspace, candidate } = input;
  if (path.dirname(candidate.canonicalPath) !== workspace.canonicalPath || candidate.device !== workspace.device
    || (path.basename(candidate.canonicalPath) !== '.next' && !retainedName.test(path.basename(candidate.canonicalPath)))) {
    throw new Error('Legacy inventory requires exact sibling relocation geometry.');
  }
  await assertWorktreeMaterializationIdentity(workspace.canonicalPath, workspace);
  await assertWorktreeMaterializationIdentity(candidate.canonicalPath, candidate);
}

/** Lexical validation only. Never resolve, stat, open or enumerate a dependency target. */
function linkTarget(input: Location, relative: string, rawTarget: string): void {
  const match = generatedLink.exec(relative);
  if (!match || Buffer.byteLength(rawTarget) > linkBytesLimit) throw new Error('Legacy dependency link shape is unsafe.');
  const [, scope, name] = match;
  const packageName = scope ? `${scope}/${name}` : name;
  const expected = `${scope ? '../../../../' : '../../../'}node_modules/${packageName}`;
  const originalTarget = path.resolve(input.workspace.canonicalPath, '.next', path.dirname(relative), rawTarget);
  const currentTarget = path.resolve(input.candidate.canonicalPath, path.dirname(relative), rawTarget);
  if (rawTarget !== expected || currentTarget !== originalTarget
    || originalTarget !== path.join(input.workspace.canonicalPath, 'node_modules', packageName)) {
    throw new Error('Legacy dependency link target is unsafe or changes across relocation.');
  }
}

async function inventory(input: Location): Promise<LegacyOutputEntry[]> {
  await location(input);
  const root = input.candidate.canonicalPath;
  const directories = new Map<string, Stats>();
  const entries: LegacyOutputEntry[] = [];
  const pending = ['.']; let bytes = 0;
  // Every path ancestor must still be the observed directory, never a link. File descriptors
  // additionally bind regular-file reads. These checks do not grant global filesystem exclusion.
  async function ancestors(relative: string): Promise<void> {
    let parent = relative === '.' ? null : path.posix.dirname(relative);
    while (parent !== null) {
      const expected = directories.get(parent); const selected = path.join(root, parent);
      const actual = await lstat(selected);
      if (!expected || !actual.isDirectory() || actual.isSymbolicLink() || !stable(expected, actual)
        || await realpath(selected) !== selected) throw new Error('Legacy inventory ancestor changed or redirected.');
      parent = parent === '.' ? null : path.posix.dirname(parent);
    }
  }
  while (pending.length) {
    const relative = pending.pop()!; safeRelative(relative);
    if (entries.length >= GENERATED_BANK_LIMITS.entries) throw new Error('Legacy inventory entry bound exceeded.');
    await ancestors(relative);
    const selected = path.join(root, relative); const before = await lstat(selected);
    if (before.dev !== input.candidate.device) throw new Error('Legacy inventory crossed a device boundary.');
    let entry: LegacyOutputEntry;
    const base = { relative, device: before.dev, inode: before.ino, mode: before.mode & 0o777 };
    if (before.isSymbolicLink()) {
      if (before.size > linkBytesLimit || before.nlink !== 1) throw new Error('Legacy link node exceeds its bounds.');
      const raw = await readlink(selected, { encoding: 'buffer' }); const rawTarget = raw.toString('utf8');
      if (!Buffer.from(rawTarget).equals(raw) || raw.length !== before.size || raw.length > linkBytesLimit) {
        throw new Error('Legacy link text is not bounded UTF-8.');
      }
      linkTarget(input, relative, rawTarget);
      entry = { ...base, kind: 'symlink', bytes: raw.length, sha256: null, rawTarget };
    } else if (before.isDirectory()) {
      if (await realpath(selected) !== selected) throw new Error('Legacy directory is redirected.');
      const descriptor = await open(selected, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        if (!stable(before, await descriptor.stat())) throw new Error('Legacy directory changed before enumeration.');
        const names: string[] = [];
        for await (const child of await opendir(selected)) {
          if (entries.length + pending.length + names.length >= GENERATED_BANK_LIMITS.entries) {
            throw new Error('Legacy inventory entry bound exceeded.');
          }
          names.push(child.name);
        }
        if (!stable(before, await descriptor.stat())) throw new Error('Legacy directory changed during enumeration.');
        for (const name of names.sort().reverse()) pending.push(relative === '.' ? name : `${relative}/${name}`);
      } finally { await descriptor.close(); }
      directories.set(relative, before);
      entry = { ...base, kind: 'directory', bytes: 0, sha256: null };
    } else if (before.isFile() && before.nlink === 1) {
      if (bytes + before.size > GENERATED_BANK_LIMITS.expandedBytes) throw new Error('Legacy inventory byte bound exceeded.');
      const descriptor = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!stable(before, await descriptor.stat())) throw new Error('Legacy file changed before reading.');
        const hash = createHash('sha256'); let count = 0;
        for await (const chunk of descriptor.createReadStream({ autoClose: false })) {
          count += chunk.length;
          if (count > before.size) throw new Error('Legacy file grew beyond its bound.');
          hash.update(chunk);
        }
        if (count !== before.size || !stable(before, await descriptor.stat())) throw new Error('Legacy file changed during reading.');
        entry = { ...base, kind: 'file', bytes: count, sha256: hash.digest('hex') };
      } finally { await descriptor.close(); }
    } else {
      throw new Error('Legacy inventory refuses special nodes and multiply linked files.');
    }
    if (!stable(before, await lstat(selected))) throw new Error('Legacy node changed during capture.');
    await ancestors(relative);
    bytes += entry.bytes;
    if (bytes > GENERATED_BANK_LIMITS.expandedBytes) throw new Error('Legacy inventory byte bound exceeded.');
    entries.push(entry);
  }
  for (const [relative, before] of directories) {
    const selected = path.join(root, relative);
    if (!stable(before, await lstat(selected)) || await realpath(selected) !== selected) {
      throw new Error('Legacy directory namespace changed across capture.');
    }
  }
  await location(input);
  entries.sort((a, b) => a.relative.localeCompare(b.relative));
  if (Buffer.byteLength(JSON.stringify(entries)) > GENERATED_BANK_LIMITS.manifestBytes) throw new Error('Legacy inventory manifest bound exceeded.');
  return entries;
}

export async function verifyLegacyOutputEntries(input: Location & { entries: LegacyOutputEntry[] }): Promise<void> {
  if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > GENERATED_BANK_LIMITS.entries
    || Buffer.byteLength(JSON.stringify(input.entries)) > GENERATED_BANK_LIMITS.manifestBytes) throw new Error('Legacy inventory authority is oversized.');
  const expected = new Map(input.entries.map(entry => [entry.relative, entry]));
  if (expected.size !== input.entries.length) throw new Error('Legacy inventory has duplicate entries.');
  const observed = await inventory(input);
  if (observed.length !== expected.size) throw new Error('Legacy inventory namespace changed.');
  for (const actual of observed) {
    const prior = expected.get(actual.relative);
    if (!prior || prior.kind !== actual.kind || prior.device !== actual.device || prior.inode !== actual.inode
      || prior.mode !== actual.mode || prior.bytes !== actual.bytes || prior.sha256 !== actual.sha256
      || (actual.kind === 'symlink' && (prior.kind !== 'symlink' || prior.rawTarget !== actual.rawTarget))) {
      throw new Error('Legacy inventory content, link text or node identity changed.');
    }
  }
}

/** Read-only: no bank, dependency traversal, journal, move, or success/disposal authority. */
export async function captureLegacyOutputEntries(input: Location): Promise<LegacyOutputEntry[]> {
  const entries = await inventory(input);
  await verifyLegacyOutputEntries({ ...input, entries });
  return entries;
}
