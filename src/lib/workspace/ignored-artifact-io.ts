import { spawn } from 'node:child_process';

import { guardedWorkspaceInvocation } from '@/lib/worktree/materialization-execution';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';

export interface IgnoredArtifactEntry {
  path: string;
  kind: 'file' | 'directory';
  mode: number;
  device: number;
  inode: number;
  bytes: number;
  sha256: string | null;
  content: string | null;
}

export interface ArtifactRevision {
  headCommit: string;
  treeSha: string;
}

export interface IgnoredArtifactCapture extends ArtifactRevision {
  entries: IgnoredArtifactEntry[];
  bytes: number;
}

export interface ArtifactRestoreFileReceipt {
  path: string;
  device: number;
  inode: number;
  phase: 'prepared' | 'complete';
}

export interface ArtifactRestoreEvent extends ArtifactRestoreFileReceipt {
  sha256: string;
  bytes: number;
}

// Work happens in an OS-pinned cwd. Parents are opened without following links,
// and each file is read/written through its own verified descriptor.
const ARTIFACT_IO_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const mode = process.argv[1];
const rootCanonical = fs.realpathSync('.');
const rootFd = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
const fdPath = (fd) => (process.platform === 'linux' ? '/proc/self/fd/' : '/dev/fd/') + fd;
let buffer = '';
const lines = [];
let reader = null;
let ended = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (reader) { const current = reader; reader = null; current.resolve(line); }
    else lines.push(line);
  }
});
process.stdin.on('end', () => {
  ended = true;
  if (reader) { reader.reject(new Error('Artifact receipt acknowledgement was lost.')); reader = null; }
});
function nextLine() {
  if (lines.length) return Promise.resolve(lines.shift());
  if (ended) return Promise.reject(new Error('Artifact request input ended.'));
  return new Promise((resolve, reject) => { reader = { resolve, reject }; });
}
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
    || path.posix.isAbsolute(value) || value.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')) {
    throw new Error('Artifact path is unsafe.');
  }
  return value;
}
function same(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mode === after.mode && before.nlink === after.nlink
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
function hash(content) { return crypto.createHash('sha256').update(content).digest('hex'); }
function readAt(fd, size) {
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(fd, content, offset, size - offset, offset);
    if (!count) throw new Error('Artifact file changed during descriptor read.');
    offset += count;
  }
  return content;
}
function syncCurrentDirectory() {
  const fd = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function enterParent(relative, create) {
  const parts = safeRelative(relative).split('/');
  const leaf = parts.pop();
  process.chdir(fdPath(rootFd));
  for (const part of parts) {
    let stat;
    try { stat = fs.lstatSync(part); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      fs.mkdirSync(part, 0o700);
      syncCurrentDirectory();
      stat = fs.lstatSync(part);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Artifact ancestor is not a regular directory.');
    const fd = fs.openSync(part, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const captured = fs.fstatSync(fd);
      if (captured.dev !== stat.dev || captured.ino !== stat.ino) throw new Error('Artifact ancestor changed.');
      process.chdir(fdPath(fd));
      const canonical = fs.realpathSync('.');
      const inside = path.relative(rootCanonical, canonical);
      if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('Artifact ancestor escaped its workspace.');
    } finally { fs.closeSync(fd); }
  }
  return leaf;
}
function inspect(relative) {
  try { return fs.lstatSync(enterParent(relative, false)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function git(args) {
  process.chdir(fdPath(rootFd));
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_WORK_TREE: rootCanonical };
  for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  return execFileSync('git', args, { encoding: 'utf8', env, timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
}
function readRevision() {
  const headCommit = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const treeSha = git(['rev-parse', '--verify', 'HEAD^{tree}']).trim();
  if (git(['ls-files', '-v', '-z']).split('\0').some((line) => /^[a-zS] /.test(line))) {
    throw new Error('Artifact capture refuses hidden index flags.');
  }
  if (git(['ls-files', '--stage', '-z']).split('\0').some((line) => line.startsWith('160000 '))) {
    throw new Error('Artifact capture requires separate submodule preservation.');
  }
  return { headCommit, treeSha };
}
function verifyGit(input) {
  const truth = readRevision();
  if (truth.headCommit !== input.headCommit || truth.treeSha !== input.treeSha) throw new Error('Artifact workspace revision changed.');
  return truth;
}
function inspectRestoreRevision() {
  const truth = readRevision();
  if (git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])) {
    throw new Error('Artifact restore destination has unbanked source changes.');
  }
  return truth;
}
function capture(input) {
  const truth = verifyGit(input);
  const ignored = [];
  for (const record of git(['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all']).split('\0')) {
    if (!record) continue;
    if (!record.startsWith('!! ')) {
      if (input.discardSource === true) continue;
      throw new Error('Source changes were not banked before artifact capture.');
    }
    ignored.push(safeRelative(record.slice(3).replace(/\/$/, '')));
  }
  const excluded = input.rebuildablePaths.map(safeRelative);
  const copied = input.copiedEnvironment;
  const entries = [];
  const seen = new Set();
  const started = Date.now();
  let bytes = 0;
  function visit(relative) {
    if (seen.has(relative) || excluded.some((prefix) => relative === prefix || relative.startsWith(prefix + '/'))) return;
    seen.add(relative);
    if (seen.size > 20000 || Date.now() - started > 10000) throw new Error('Artifact capture scan bound was exceeded.');
    const leaf = enterParent(relative, false);
    const stat = fs.lstatSync(leaf);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Unique ignored content has an unsupported filesystem node.');
    if (stat.isDirectory()) {
      const names = fs.readdirSync(leaf).sort();
      entries.push({ path: relative, kind: 'directory', mode: stat.mode & 0o777, device: stat.dev, inode: stat.ino, bytes: 0, sha256: null, content: null });
      for (const name of names) visit(safeRelative(relative + '/' + name));
      const repeated = enterParent(relative, false);
      const after = fs.lstatSync(repeated);
      if (!same(stat, after) || JSON.stringify(names) !== JSON.stringify(fs.readdirSync(repeated).sort())) throw new Error('Ignored artifact directory changed during capture.');
      return;
    }
    const copy = Object.prototype.hasOwnProperty.call(copied, relative) ? copied[relative] : undefined;
    if (copy === undefined && /^\.env(?:\.|$)/.test(path.basename(relative))) throw new Error('An unbound ignored environment file requires a privacy decision.');
    if (stat.size > 16 * 1024 * 1024 || bytes + stat.size > 32 * 1024 * 1024) throw new Error('Unique ignored artifact bytes exceed the bounded preservation budget.');
    const fd = fs.openSync(leaf, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (!same(stat, opened)) throw new Error('Ignored artifact file changed before capture.');
      const content = readAt(fd, opened.size);
      const repeated = readAt(fd, opened.size);
      const after = fs.fstatSync(fd);
      const named = fs.lstatSync(leaf);
      if (!same(opened, after) || named.dev !== after.dev || named.ino !== after.ino || !content.equals(repeated)) throw new Error('Ignored artifact file changed during capture.');
      const sha256 = hash(content);
      if (copy !== undefined) {
        if (copy === null || copy !== sha256) throw new Error('Copied environment binding changed; the workspace remains held.');
        return;
      }
      bytes += content.length;
      entries.push({ path: relative, kind: 'file', mode: stat.mode & 0o777, device: stat.dev, inode: stat.ino, bytes: content.length, sha256, content: content.toString('base64') });
    } finally { fs.closeSync(fd); }
  }
  for (const relative of [...new Set(ignored)].sort()) visit(relative);
  verifyGit(input);
  return { ...truth, entries: entries.sort((a, b) => a.path.localeCompare(b.path)), bytes };
}
async function receipt(event) {
  process.stdout.write('O8_ARTIFACT_EVENT ' + Buffer.from(JSON.stringify(event)).toString('base64url') + '\n');
  if (await nextLine() !== 'ok') throw new Error('Artifact ownership receipt was not persisted.');
}
async function restore(input) {
  verifyGit(input);
  if (git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])) {
    throw new Error('Artifact restore destination has unbanked source changes.');
  }
  const owned = new Map(input.ownedFiles.map((entry) => [entry.path, entry]));
  const seen = new Set();
  let totalBytes = 0;
  for (const entry of input.entries) {
    safeRelative(entry.path);
    if (seen.has(entry.path) || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new Error('Artifact manifest is invalid.');
    seen.add(entry.path);
    if (entry.kind !== 'file' && entry.kind !== 'directory') throw new Error('Artifact kind is unsupported.');
    if (entry.kind === 'file') {
      const content = Buffer.from(entry.content, 'base64');
      totalBytes += content.length;
      if (content.length !== entry.bytes || content.toString('base64') !== entry.content || hash(content) !== entry.sha256
        || content.length > 16 * 1024 * 1024 || totalBytes > 32 * 1024 * 1024) throw new Error('Artifact content receipt is invalid.');
      git(['check-ignore', '--quiet', '--', entry.path]);
    }
    const prior = inspect(entry.path);
    if (!prior) {
      if (owned.has(entry.path)) throw new Error('A previously owned artifact restore file disappeared.');
      continue;
    }
    if (entry.kind === 'directory') {
      if (!prior.isDirectory() || prior.isSymbolicLink()) throw new Error('Artifact directory destination is occupied.');
      continue;
    }
    const owner = owned.get(entry.path);
    if (!owner || !prior.isFile() || prior.isSymbolicLink() || prior.dev !== owner.device || prior.ino !== owner.inode || prior.nlink !== 1) {
      throw new Error('Artifact restore refuses to overwrite an unowned destination.');
    }
  }
  for (const entry of input.entries.filter((entry) => entry.kind === 'directory').sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    const leaf = enterParent(entry.path, true);
    if (!fs.existsSync(leaf)) { fs.mkdirSync(leaf, 0o700); syncCurrentDirectory(); }
    const directory = fs.lstatSync(leaf);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Artifact directory destination changed.');
  }
  for (const entry of input.entries.filter((entry) => entry.kind === 'file')) {
    const leaf = enterParent(entry.path, true);
    const owner = owned.get(entry.path);
    const content = Buffer.from(entry.content, 'base64');
    const flags = owner ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
      : fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
    let fd = fs.openSync(leaf, flags, 0o600);
    try {
      const before = fs.fstatSync(fd);
      const named = fs.lstatSync(leaf);
      if (!before.isFile() || before.nlink !== 1 || named.dev !== before.dev || named.ino !== before.ino
        || (owner && (before.dev !== owner.device || before.ino !== owner.inode))) throw new Error('Artifact destination identity changed.');
      if (before.size > content.length) throw new Error('A previously owned restore file grew beyond its bounded receipt.');
      const existing = readAt(fd, before.size);
      if (!same(before, fs.fstatSync(fd)) || !same(before, fs.lstatSync(leaf))) throw new Error('Artifact destination changed during verification.');
      if (owner && (before.size > content.length || !existing.equals(content.subarray(0, existing.length))
        || (owner.phase === 'complete' && (hash(existing) !== entry.sha256 || (before.mode & 0o777) !== entry.mode)))) {
        throw new Error('A previously owned restore file was modified; no overwrite was applied.');
      }
      if (owner && owner.phase === 'complete') continue;
      if (owner && existing.equals(content) && (before.mode & 0o777) === entry.mode) {
        fs.fsyncSync(fd);
        if (!same(before, fs.fstatSync(fd)) || !same(before, fs.lstatSync(leaf))) throw new Error('Prepared artifact changed during read-only recovery.');
        await receipt({ path: entry.path, device: before.dev, inode: before.ino, phase: 'complete', sha256: entry.sha256, bytes: entry.bytes });
        continue;
      }
      if (owner) {
        const writable = fs.openSync(leaf, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
        const captured = fs.fstatSync(writable);
        if (!same(before, captured) || !same(before, fs.lstatSync(leaf))) {
          fs.closeSync(writable);
          throw new Error('Prepared artifact changed before retry publication.');
        }
        fs.closeSync(fd);
        fd = writable;
      }
      fs.fsyncSync(fd);
      syncCurrentDirectory();
      await receipt({ path: entry.path, device: before.dev, inode: before.ino, phase: 'prepared', sha256: entry.sha256, bytes: entry.bytes });
      let offset = 0;
      while (offset < content.length) offset += fs.writeSync(fd, content, offset, content.length - offset, offset);
      fs.ftruncateSync(fd, content.length);
      fs.fchmodSync(fd, entry.mode);
      fs.fsyncSync(fd);
      const after = fs.fstatSync(fd);
      const published = fs.lstatSync(leaf);
      if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1
        || published.dev !== after.dev || published.ino !== after.ino || hash(readAt(fd, after.size)) !== entry.sha256) throw new Error('Artifact publication did not match its receipt.');
      await receipt({ path: entry.path, device: after.dev, inode: after.ino, phase: 'complete', sha256: entry.sha256, bytes: entry.bytes });
    } finally { fs.closeSync(fd); }
  }
  verifyGit(input);
  if (git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])) {
    throw new Error('Artifact restore destination changed source during publication.');
  }
  return { restoredFiles: input.entries.filter((entry) => entry.kind === 'file').length, bytes: totalBytes };
}
(async () => {
  const input = JSON.parse(await nextLine());
  const result = mode === 'revision' ? inspectRestoreRevision()
    : mode === 'capture' ? capture(input) : await restore(input);
  process.stdout.write('O8_ARTIFACT_RESULT ' + Buffer.from(JSON.stringify(result)).toString('base64url') + '\n');
  fs.closeSync(rootFd);
  process.exit(0);
})().catch(() => {
  process.stderr.write('Pinned artifact operation refused; preservation and retention authority remain intact.\n');
  process.exit(78);
});
`;

async function runArtifactIo<T>(input: {
  workspacePath: string;
  identity: WorktreeMaterializationIdentity;
  mode: 'capture' | 'restore' | 'revision';
  request: unknown;
  onReceipt?: (event: ArtifactRestoreEvent) => void;
}): Promise<T> {
  const invocation = guardedWorkspaceInvocation(
    process.execPath, ['-e', ARTIFACT_IO_SCRIPT, input.mode], input.identity,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: input.workspacePath, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    let outputBytes = 0;
    let result: T | undefined;
    let failure: Error | null = null;
    const timeout = setTimeout(() => {
      failure = new Error('Pinned artifact operation exceeded its time bound.');
      child.kill();
    }, 30_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 64 * 1024 * 1024) {
        failure = new Error('Pinned artifact output exceeded its byte bound.');
        child.kill();
        return;
      }
      output += chunk;
      let newline: number;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        try {
          if (line.startsWith('O8_ARTIFACT_EVENT ')) {
            if (!input.onReceipt) throw new Error('Artifact ownership receipt handler is absent.');
            const event = JSON.parse(Buffer.from(line.slice(18), 'base64url').toString('utf8')) as ArtifactRestoreEvent;
            input.onReceipt(event);
            child.stdin.write('ok\n');
          } else if (line.startsWith('O8_ARTIFACT_RESULT ')) {
            result = JSON.parse(Buffer.from(line.slice(19), 'base64url').toString('utf8')) as T;
          } else {
            throw new Error('Artifact worker returned an unrecognized receipt.');
          }
        } catch (error) {
          failure = error instanceof Error ? error : new Error('Artifact receipt persistence failed.');
          child.stdin.destroy();
          child.kill();
        }
      }
    });
    child.stderr.resume();
    child.on('error', (error) => { failure = error; });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (failure || code !== 0 || result === undefined) {
        reject(failure ?? new Error('Pinned artifact operation refused; source evidence remains held.'));
      } else resolve(result);
    });
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify(input.request) + '\n');
  });
}

export function captureIgnoredArtifacts(input: {
  workspacePath: string;
  identity: WorktreeMaterializationIdentity;
  headCommit: string;
  treeSha: string;
  rebuildablePaths: string[];
  copiedEnvironment: Record<string, string | null>;
  discardSource?: boolean;
}): Promise<IgnoredArtifactCapture> {
  return runArtifactIo({ ...input, mode: 'capture', request: input });
}

export function restoreIgnoredArtifacts(input: {
  workspacePath: string;
  identity: WorktreeMaterializationIdentity;
  capture: IgnoredArtifactCapture;
  destinationRevision: ArtifactRevision;
  ownedFiles: ArtifactRestoreFileReceipt[];
  onReceipt: (event: ArtifactRestoreEvent) => void;
}): Promise<{ restoredFiles: number; bytes: number }> {
  return runArtifactIo({
    ...input, mode: 'restore',
    request: { ...input.capture, ...input.destinationRevision, ownedFiles: input.ownedFiles },
  });
}

export function inspectArtifactRestoreRevision(input: {
  workspacePath: string;
  identity: WorktreeMaterializationIdentity;
}): Promise<ArtifactRevision> {
  return runArtifactIo({ ...input, mode: 'revision', request: {} });
}
