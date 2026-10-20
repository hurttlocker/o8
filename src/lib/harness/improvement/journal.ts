import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, opendirSync, readSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { advanceExperiment, createExperiment, revokeExperimentLesson, settleExperiment, validatePersistedExperiment } from './engine';
import type { ImprovementExperiment } from './types';
import { canonical, digest, integer, object, text } from './validation';

export interface ImprovementJournalLimits {
  maxSnapshotBytes?: number;
  maxJournalBytes?: number;
  maxRevisions?: number;
}
export interface ImprovementJournal {
  /** Missing journals return null. Unsafe, partial or corrupted journals never do. */
  read(id: string): ImprovementExperiment | null;
  /** Persist BEFORE executing a reservation. null expects a previously absent experiment. */
  append(state: ImprovementExperiment, expectedRevision: number | null): ImprovementExperiment;
}
interface Envelope {
  schema: 'o8/harness-refinement-journal/v1';
  previousDigest: string | null;
  state: ImprovementExperiment;
  digest: string;
}
interface Boundary { path: string; stat: Stats; fd: number }
interface Snapshot { state: ImprovementExperiment | null; digest: string | null; bytes: number }
const DEFAULTS = { maxSnapshotBytes: 16 * 1024 * 1024, maxJournalBytes: 128 * 1024 * 1024, maxRevisions: 4096 };
const CAPS = { maxSnapshotBytes: 64 * 1024 * 1024, maxJournalBytes: 512 * 1024 * 1024, maxRevisions: 4096 };
const REVISION_NAME = /^\d{6}\.json$/;

function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function sameIdentity(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function privateEntry(stat: Stats): void {
  if (stat.uid !== process.geteuid!() || (stat.mode & 0o077) !== 0) {
    throw new Error('Journal storage must have private owner-only permissions.');
  }
}
function directoryStat(path: string, privateRequired: boolean): Stats {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe journal directory or symlink.');
  if (privateRequired) privateEntry(stat);
  // Shared temporary roots must have sticky protection. Other users must not be
  // able to replace an ancestor of the private experiment namespace.
  if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) throw new Error('Unsafe writable journal ancestor.');
  if (stat.uid !== process.geteuid!() && stat.uid !== 0) throw new Error('Journal ancestor has an untrusted owner.');
  return stat;
}
function openDirectory(path: string, privateRequired: boolean): Boundary {
  const stat = directoryStat(path, privateRequired);
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!sameIdentity(stat, fstatSync(fd))) throw new Error('Journal directory changed while opening.');
    return { path, stat, fd };
  } catch (error) { closeSync(fd); throw error; }
}
function checkBoundary(boundary: Boundary): void {
  const current = directoryStat(boundary.path, false);
  if (!sameIdentity(current, boundary.stat) || !sameIdentity(fstatSync(boundary.fd), boundary.stat)
    || current.mode !== boundary.stat.mode) throw new Error('Journal directory identity changed.');
}
function syncDirectory(path: string): void {
  const boundary = openDirectory(path, false);
  try { fsyncSync(boundary.fd); checkBoundary(boundary); } finally { closeSync(boundary.fd); }
}

/** Walk all ancestors without following symlinks; create only explicitly requested private storage. */
function prepareDirectory(path: string, create: boolean): Boundary[] | null {
  const root = parse(path).root;
  const parts = path.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  const boundaries: Boundary[] = [];
  try {
    boundaries.push(openDirectory(current, false));
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]!);
      try { directoryStat(current, index === parts.length - 1); } catch (error) {
        if (!absent(error)) throw error;
        if (!create) { for (const entry of boundaries) closeSync(entry.fd); return null; }
        for (const entry of boundaries) checkBoundary(entry);
        try { mkdirSync(current, { mode: 0o700 }); } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
        }
        syncDirectory(dirname(current));
      }
      boundaries.push(openDirectory(current, index === parts.length - 1));
    }
    return boundaries;
  } catch (error) { for (const entry of boundaries) closeSync(entry.fd); throw error; }
}
function checkBoundaries(boundaries: Boundary[]): void { for (const boundary of boundaries) checkBoundary(boundary); }
function regularFile(path: string): Stats {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error('Unsafe journal entry: expected a single-link regular file.');
  }
  privateEntry(stat);
  return stat;
}
function sameFile(a: Stats, b: Stats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mode === b.mode && a.nlink === b.nlink
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function boundedRead(path: string, before: Stats, maxBytes: number): Buffer {
  if (before.size > maxBytes) throw new Error('Journal snapshot byte budget exceeded.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameFile(before, fstatSync(fd))) throw new Error('Journal file changed before reading.');
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) throw new Error('Journal snapshot is truncated.');
      offset += count;
    }
    if (!sameFile(before, fstatSync(fd)) || !sameFile(before, regularFile(path))) {
      throw new Error('Journal file changed while reading.');
    }
    return buffer;
  } finally { closeSync(fd); }
}
function assertTransition(previous: ImprovementExperiment | null, next: ImprovementExperiment): void {
  validatePersistedExperiment(next);
  if (!previous) {
    if (canonical(next) !== canonical(createExperiment(next.manifest))) throw new Error('Initial journal revision is not a fresh experiment.');
    return;
  }
  if (next.manifestDigest !== previous.manifestDigest || next.scopeDigest !== previous.scopeDigest) {
    throw new Error('Journal experiment manifest binding changed.');
  }
  let expected: ImprovementExperiment;
  if (next.lessonRevocations.length === previous.lessonRevocations.length + 1) {
    const event = next.lessonRevocations.at(-1)!;
    expected = revokeExperimentLesson(previous, event.lessonId, event.reason);
  } else if (next.pendingReceipt) expected = settleExperiment(previous, next.pendingReceipt);
  else if (next.records.length === previous.records.length + 1) {
    expected = settleExperiment(previous, next.records[next.records.length - 1]!.receipt);
  } else expected = advanceExperiment(previous);
  if (expected.revision !== previous.revision + 1 || canonical(next) !== canonical(expected)) {
    throw new Error('Journal state is not the next deterministic transition.');
  }
}
function readSnapshot(directory: string, id: string, limits: Required<ImprovementJournalLimits>): Snapshot {
  const entries: string[] = [];
  const listing = opendirSync(directory);
  try {
    for (let entry = listing.readSync(); entry; entry = listing.readSync()) {
      if (entries.length >= limits.maxRevisions) throw new Error('Journal revision budget exceeded.');
      if (!REVISION_NAME.test(entry.name)) throw new Error('Unexpected or uncommitted journal entry; outcome is uncertain.');
      entries.push(entry.name);
    }
  } finally { listing.closeSync(); }
  entries.sort();
  let snapshot: Snapshot = { state: null, digest: null, bytes: 0 };
  for (let revision = 0; revision < entries.length; revision += 1) {
    if (entries[revision] !== `${String(revision).padStart(6, '0')}.json`) throw new Error('Journal revision sequence has a gap.');
    const path = join(directory, entries[revision]!);
    const stat = regularFile(path);
    if (stat.size > limits.maxJournalBytes - snapshot.bytes) throw new Error('Journal total byte budget exceeded.');
    const value = JSON.parse(boundedRead(path, stat, limits.maxSnapshotBytes).toString('utf8')) as Envelope;
    object(value, ['schema', 'previousDigest', 'state', 'digest']);
    if (value.schema !== 'o8/harness-refinement-journal/v1' || value.previousDigest !== snapshot.digest
      || value.digest !== digest({ schema: value.schema, previousDigest: value.previousDigest, state: value.state })) {
      throw new Error('Journal hash chain is corrupt.');
    }
    if (value.state?.revision !== revision || value.state?.manifest?.id !== id) throw new Error('Journal revision or experiment binding is corrupt.');
    assertTransition(snapshot.state, value.state);
    snapshot = { state: value.state, digest: value.digest, bytes: snapshot.bytes + stat.size };
  }
  return snapshot;
}

/**
 * Dedicated, caller-selected storage only. No provider, runtime or production-data lookup occurs here.
 *
 * A durable private temporary file is published by hard-link create-if-absent, never rename/replace.
 * Cooperating writers use the next revision name as a cross-process CAS. There are no stale locks.
 * A crash can leave an uncommitted scratch entry: reads and writes then fail closed, preserving all
 * evidence for explicit reconciliation rather than guessing whether a reservation was committed.
 * Hash chaining is corruption detection, not authentication against an actor with the same OS user.
 * Limits are per experiment; callers must additionally bound the number of experiment IDs they admit.
 */
export function createImprovementJournal(directory: string, options: ImprovementJournalLimits = {}): ImprovementJournal {
  text(directory, 4096);
  if (typeof process.geteuid !== 'function' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
    throw new Error('Private refinement journals require POSIX no-follow filesystem support.');
  }
  object(options, ['maxSnapshotBytes', 'maxJournalBytes', 'maxRevisions'], []);
  const limits = { ...DEFAULTS, ...options };
  for (const key of ['maxSnapshotBytes', 'maxJournalBytes', 'maxRevisions'] as const) integer(limits[key], 1, CAPS[key]);
  const root = resolve(directory);

  function access<T>(id: string, create: boolean, operation: (path: string, boundaries: Boundary[]) => T): T | null {
    text(id, 1024);
    const boundaries = prepareDirectory(root, create);
    if (!boundaries) return null;
    try {
      const path = join(root, digest(id));
      try { directoryStat(path, true); } catch (error) {
        if (!absent(error)) throw error;
        if (!create) return null;
        checkBoundaries(boundaries);
        try { mkdirSync(path, { mode: 0o700 }); } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
        }
        fsyncSync(boundaries[boundaries.length - 1]!.fd);
      }
      boundaries.push(openDirectory(path, true));
      checkBoundaries(boundaries);
      const result = operation(path, boundaries);
      checkBoundaries(boundaries);
      return result;
    } finally { for (const boundary of boundaries) closeSync(boundary.fd); }
  }

  return {
    read(id) { return access(id, false, (path) => readSnapshot(path, id, limits).state); },
    append(input, expectedRevision) {
      if (expectedRevision !== null) integer(expectedRevision, 0, limits.maxRevisions - 1);
      const state = structuredClone(input);
      validatePersistedExperiment(state);
      if (state.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) throw new Error('Journal revision conflict.');
      if (state.revision >= limits.maxRevisions) throw new Error('Journal revision budget exceeded.');
      // Check the large caller-owned value before creating any on-disk namespace.
      if (Buffer.byteLength(JSON.stringify(state)) > limits.maxSnapshotBytes) throw new Error('Journal snapshot byte budget exceeded.');
      const result = access(state.manifest.id, true, (path, boundaries) => {
        const current = readSnapshot(path, state.manifest.id, limits);
        if ((current.state?.revision ?? null) !== expectedRevision) throw new Error('Journal revision conflict.');
        assertTransition(current.state, state);
        const payload = { schema: 'o8/harness-refinement-journal/v1' as const, previousDigest: current.digest, state };
        const content = Buffer.from(`${JSON.stringify({ ...payload, digest: digest(payload) })}\n`);
        if (content.length > limits.maxSnapshotBytes || content.length > limits.maxJournalBytes - current.bytes) {
          throw new Error('Journal snapshot or total byte budget exceeded.');
        }
        const temporary = join(path, `.pending-${randomUUID()}.json`);
        const target = join(path, `${String(state.revision).padStart(6, '0')}.json`);
        checkBoundaries(boundaries);
        const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        let owned: Stats | undefined;
        let published = false;
        try {
          owned = fstatSync(fd);
          privateEntry(owned);
          if (!owned.isFile() || owned.nlink !== 1) throw new Error('Unsafe journal scratch file.');
          writeFileSync(fd, content);
          fsyncSync(fd);
          checkBoundaries(boundaries);
          if (!sameIdentity(regularFile(temporary), owned)) throw new Error('Journal scratch identity changed.');
          try { linkSync(temporary, target); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Journal revision conflict.');
            throw error;
          }
          published = true;
          // The temporary name is ours, not user data. Never remove an unrelated replacement.
          if (!sameIdentity(lstatSync(temporary), owned)) throw new Error('Journal scratch identity changed after publication.');
          unlinkSync(temporary);
          if (!sameIdentity(regularFile(target), owned)) throw new Error('Journal published identity changed.');
          fsyncSync(boundaries[boundaries.length - 1]!.fd);
          checkBoundaries(boundaries);
          return structuredClone(state);
        } catch (error) {
          if (published) throw new Error('Journal publication outcome is uncertain; inspect the existing revision before any execution or retry.', { cause: error });
          checkBoundaries(boundaries);
          const named = lstatSync(temporary);
          if (owned && sameIdentity(named, owned) && named.isFile() && named.nlink === 1) {
            unlinkSync(temporary);
            fsyncSync(boundaries[boundaries.length - 1]!.fd);
          }
          throw error;
        } finally { closeSync(fd); }
      });
      if (!result) throw new Error('Journal storage is unavailable.');
      return result;
    },
  };
}
