/** Read-only access to the bundled Pi worker's normalized logs, never raw Pi sessions. */
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { PI_BUILTIN_SURFACE_PREFIX } from './types';

export const PI_BUILTIN_TELEMETRY_MAX_BYTES = 256_000;
const MAX_METADATA_BYTES = 1_048_576;
const MAX_RECENT_RUNS = 32;
// An exact end assertion, unlike $, also rejects a final newline.
const SAFE_COMPONENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}(?![\s\S])/;

export interface PiBuiltinTelemetrySources {
  threadId?: string;
  model?: string;
  /** Oldest first, matching the owned-session telemetry contract. */
  stdoutPaths: string[];
}

export interface PiBuiltinTelemetryTail {
  raw: string;
  modifiedAt?: string;
  /** Actual log bytes read, including discarded partial lines and rejected snapshots. */
  bytesRead: number;
}

interface DirectoryIdentity {
  name: string;
  canonical: string;
  stat: Stats;
}

interface CheckedFile {
  name: string;
  handle: FileHandle;
  stat: Stats;
  directories: DirectoryIdentity[];
}

interface ResolvedSources extends PiBuiltinTelemetrySources {
  root: string;
  sessionDir: string;
  directories: DirectoryIdentity[];
}

function sameNode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Only owned path components are checked: platform ancestors such as /tmp may be aliases. */
async function checkDirectories(root: string, sessionDir: string, runs: boolean): Promise<DirectoryIdentity[]> {
  const names = [root, sessionDir, ...(runs ? [path.join(sessionDir, 'runs')] : [])];
  const identities: DirectoryIdentity[] = [];
  for (const name of names) {
    const stat = await lstat(name);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid Pi telemetry directory.');
    const canonical = await realpath(name);
    const parent = identities.at(-1);
    if (parent && canonical !== path.join(parent.canonical, path.basename(name))) {
      throw new Error('Redirected Pi telemetry directory.');
    }
    identities.push({ name, canonical, stat });
  }
  return identities;
}

/** Recheck the named object against the opened handle, including its entire owned directory chain. */
async function verifyFile(file: CheckedFile): Promise<Stats> {
  for (const directory of file.directories) {
    const current = await lstat(directory.name);
    if (!current.isDirectory() || current.isSymbolicLink() || !sameNode(current, directory.stat)
      || await realpath(directory.name) !== directory.canonical) {
      throw new Error('Pi telemetry directory changed.');
    }
  }
  const named = await lstat(file.name);
  const opened = await file.handle.stat();
  const parent = file.directories.at(-1)!;
  if (!named.isFile() || named.isSymbolicLink() || !opened.isFile() || named.nlink !== 1 || opened.nlink !== 1
    || !sameNode(named, file.stat) || !sameNode(opened, file.stat)
    || await realpath(file.name) !== path.join(parent.canonical, path.basename(file.name))) {
    throw new Error('Pi telemetry file is redirected or changed.');
  }
  return opened;
}

async function openCheckedFile(
  root: string, sessionDir: string, name: string, runs: boolean, expected: DirectoryIdentity[] = [],
): Promise<CheckedFile> {
  const directories = await checkDirectories(root, sessionDir, runs);
  if (expected.some((directory, index) => !sameNode(directory.stat, directories[index].stat)
    || directory.canonical !== directories[index].canonical)) {
    throw new Error('Pi telemetry session changed after metadata validation.');
  }
  const named = await lstat(name);
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) throw new Error('Invalid Pi telemetry file.');
  // NONBLOCK also avoids hanging if a regular file is replaced with a FIFO during open.
  const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const file = { name, handle, stat: await handle.stat(), directories };
    if (!sameNode(named, file.stat)) throw new Error('Pi telemetry file changed during open.');
    await verifyFile(file);
    return file;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readMetadata(root: string, sessionDir: string): Promise<{
  metadata: Record<string, unknown>;
  directories: DirectoryIdentity[];
  stat: Stats;
}> {
  const file = await openCheckedFile(root, sessionDir, path.join(sessionDir, 'session.json'), false);
  try {
    if (file.stat.size > MAX_METADATA_BYTES) throw new Error('Pi metadata exceeds its read limit.');
    const buffer = Buffer.alloc(file.stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await verifyFile(file);
    if (length !== file.stat.size || after.size !== file.stat.size
      || after.mtimeMs !== file.stat.mtimeMs || after.ctimeMs !== file.stat.ctimeMs) {
      throw new Error('Pi metadata changed during read.');
    }
    const value: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Pi metadata.');
    return { metadata: value as Record<string, unknown>, directories: file.directories, stat: file.stat };
  } finally {
    await file.handle.close();
  }
}

function optionalLabel(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 256 ? value : undefined;
}

async function resolveSources(surfaceId: string): Promise<ResolvedSources | null> {
  // Validate BEFORE resolving roots or performing any filesystem lookup. Never trim an identity.
  if (typeof surfaceId !== 'string' || !surfaceId.startsWith(PI_BUILTIN_SURFACE_PREFIX)) return null;
  const suffix = surfaceId.slice(PI_BUILTIN_SURFACE_PREFIX.length);
  if (!SAFE_COMPONENT.test(suffix)) return null;

  // Passing an environment copy deliberately selects pure resolution, without migration or mkdir.
  const activeRoot = path.resolve(process.env.O8_OWNED_PI_BUILTIN_ROOT
    || path.join(getDataDir({ ...process.env }), 'owned-pi-builtin'));
  const archiveRoot = `${activeRoot}-archive`;
  const activeSessionDir = path.join(activeRoot, suffix);
  for (const root of [activeRoot, archiveRoot]) {
    const sessionDir = path.join(root, suffix);
    try {
      await lstat(sessionDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return null;
    }
    // An occupied but invalid active identity must not silently select a different archived record.
    try {
      const { metadata, directories, stat: metadataStat } = await readMetadata(root, sessionDir);
      if (metadata.surfaceId !== surfaceId || metadata.sessionDir !== sessionDir
        || !Array.isArray(metadata.recentRuns)) return null;
      const stdoutPaths: string[] = [];
      const seen = new Set<string>();
      for (const value of metadata.recentRuns.slice(0, MAX_RECENT_RUNS)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const run = value as Record<string, unknown>;
        if (typeof run.id !== 'string' || !SAFE_COMPONENT.test(run.id) || seen.has(run.id)) continue;
        seen.add(run.id);
        const name = `${run.id}.jsonl`;
        const stdoutPath = path.join(sessionDir, 'runs', name);
        const originalPath = path.join(activeSessionDir, 'runs', name);
        // Archive is a directory rename. Only this exact matching active run path may be rebased.
        if (run.stdoutPath !== stdoutPath && !(root === archiveRoot && run.stdoutPath === originalPath)) continue;
        try {
          const file = await openCheckedFile(root, sessionDir, stdoutPath, true, directories);
          await file.handle.close();
          stdoutPaths.push(stdoutPath);
        } catch {
          // Missing, nonregular or redirected logs are never exposed as usable telemetry sources.
        }
      }
      // Enumeration must not return paths authorized by a metadata object replaced in the meantime.
      const metadataFile = await openCheckedFile(root, sessionDir, path.join(sessionDir, 'session.json'), false, directories);
      try {
        if (!sameNode(metadataFile.stat, metadataStat) || metadataFile.stat.size !== metadataStat.size
          || metadataFile.stat.mtimeMs !== metadataStat.mtimeMs || metadataFile.stat.ctimeMs !== metadataStat.ctimeMs) {
          return null;
        }
      } finally {
        await metadataFile.handle.close();
      }
      return { root, sessionDir, directories,
        threadId: optionalLabel(metadata.threadId), model: optionalLabel(metadata.model),
        stdoutPaths: stdoutPaths.reverse() };
    } catch {
      return null;
    }
  }
  return null;
}

export async function getOwnedPiBuiltinTelemetrySources(surfaceId: string): Promise<PiBuiltinTelemetrySources | null> {
  const sources = await resolveSources(surfaceId);
  if (!sources) return null;
  return { threadId: sources.threadId, model: sources.model, stdoutPaths: sources.stdoutPaths };
}

async function readRunTail(sources: ResolvedSources, stdoutPath: string, budget: number): Promise<PiBuiltinTelemetryTail> {
  let bytesRead = 0;
  let file: CheckedFile | undefined;
  try {
    file = await openCheckedFile(sources.root, sources.sessionDir, stdoutPath, true, sources.directories);
    const length = Math.min(file.stat.size, budget);
    const start = file.stat.size - length;
    const buffer = Buffer.alloc(length);
    while (bytesRead < length) {
      const read = await file.handle.read(buffer, bytesRead, length - bytesRead, start + bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    const after = await verifyFile(file);
    if (after.size < file.stat.size || bytesRead !== length) return { raw: '', bytesRead };
    // A tail may begin inside a JSON record or UTF-8 code point. Only whole newline-delimited
    // records are eligible; an unterminated final record may still be in flight.
    const first = start > 0 ? buffer.indexOf(10) + 1 : 0;
    const last = buffer.lastIndexOf(10);
    const raw = (start > 0 && first === 0) || last < first ? ''
      : buffer.subarray(first, last + 1).toString('utf8');
    return { raw, modifiedAt: file.stat.mtime.toISOString(), bytesRead };
  } catch {
    return { raw: '', bytesRead };
  } finally {
    await file?.handle.close();
  }
}

/** One aggregate byte budget, newest runs first; never consult Pi's provider/session directories. */
export async function readOwnedPiBuiltinTelemetryTail(surfaceId: string): Promise<PiBuiltinTelemetryTail> {
  const sources = await resolveSources(surfaceId);
  if (!sources) return { raw: '', bytesRead: 0 };
  const chunks: string[] = [];
  let bytesRead = 0;
  let modifiedAt: string | undefined;
  for (const stdoutPath of [...sources.stdoutPaths].reverse()) {
    if (bytesRead >= PI_BUILTIN_TELEMETRY_MAX_BYTES) break;
    const tail = await readRunTail(sources, stdoutPath, PI_BUILTIN_TELEMETRY_MAX_BYTES - bytesRead);
    bytesRead += tail.bytesRead;
    if (!modifiedAt && tail.modifiedAt) modifiedAt = tail.modifiedAt;
    if (tail.raw) chunks.unshift(tail.raw);
  }
  return { raw: chunks.join(''), modifiedAt, bytesRead };
}
