import { spawn } from 'node:child_process';

import { ARTIFACT_PROTOCOL_SCRIPT } from '@/lib/workspace/ignored-artifact-protocol';
import { artifactNodeScript } from '@/lib/workspace/ignored-artifact-worker';

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
const ARTIFACT_IO_SCRIPT = ARTIFACT_PROTOCOL_SCRIPT + String.raw`
const { execFileSync } = require('node:child_process');
const mode = process.argv[1];
const workerScript = process.argv[2];
const rootFd = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
let rootIdentity;
function verifyRoot() {
  const actual = fs.lstatSync('.');
  const pinned = fs.fstatSync(rootFd);
  if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== rootIdentity.device
    || actual.ino !== rootIdentity.inode || pinned.dev !== actual.dev || pinned.ino !== actual.ino
    || fs.realpathSync('.') !== rootIdentity.canonicalPath) throw new Error('Artifact workspace ownership changed.');
}
function git(args) {
  verifyRoot();
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_WORK_TREE: '.' };
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
async function receipt(event) {
  process.stdout.write('O8_ARTIFACT_EVENT ' + Buffer.from(JSON.stringify(event)).toString('base64url') + '\n');
  if (await nextLine() !== 'ok') throw new Error('Artifact ownership receipt was not persisted.');
}
async function capture(input) {
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
  const client = await connectArtifactNode(workerScript, '.', rootIdentity, rootIdentity.canonicalPath,
    started + 10000, async () => { throw new Error('Capture cannot publish restore receipts.'); });
  try {
    async function visit(relative) {
      if (seen.has(relative) || excluded.some((prefix) => relative === prefix || relative.startsWith(prefix + '/'))) return;
      seen.add(relative);
      if (seen.size > 20000 || Date.now() - started > 10000) throw new Error('Artifact capture scan bound was exceeded.');
      verifyRoot();
      const copiedBound = Object.prototype.hasOwnProperty.call(copied, relative);
      const captured = await client.request({ action: 'capture', path: relative, originalPath: relative,
        copiedBound, copiedHash: copiedBound ? copied[relative] : null, remainingBytes: 32 * 1024 * 1024 - bytes });
      if (captured.entry) entries.push(captured.entry);
      if (captured.stat.kind === 'directory') {
        for (const name of captured.names) await visit(safeRelative(relative + '/' + name));
        await client.request({ action: 'verify-directory', path: relative, stat: captured.stat, names: captured.names });
      } else if (captured.entry) bytes += captured.entry.bytes;
    }
    for (const relative of [...new Set(ignored)].sort()) await visit(relative);
  } finally { await client.close(); }
  verifyGit(input);
  return { ...truth, entries: entries.sort((a, b) => a.path.localeCompare(b.path)), bytes };
}
async function restore(input) {
  verifyGit(input);
  if (git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])) {
    throw new Error('Artifact restore destination has unbanked source changes.');
  }
  const owned = new Map(input.ownedFiles.map((entry) => [entry.path, entry]));
  const seen = new Set();
  let totalBytes = 0;
  if (input.entries.length > 20000) throw new Error('Artifact restore entry bound was exceeded.');
  const client = await connectArtifactNode(workerScript, '.', rootIdentity, rootIdentity.canonicalPath,
    Date.now() + 29000, receipt);
  try {
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
      const prior = await client.request({ action: 'inspect', path: entry.path });
      if (!prior) {
        if (owned.has(entry.path)) throw new Error('A previously owned artifact restore file disappeared.');
        continue;
      }
      if (entry.kind === 'directory') {
        if (prior.kind !== 'directory') throw new Error('Artifact directory destination is occupied.');
        continue;
      }
      const owner = owned.get(entry.path);
      if (!owner || prior.kind !== 'file' || prior.dev !== owner.device || prior.ino !== owner.inode || prior.nlink !== 1) {
        throw new Error('Artifact restore refuses to overwrite an unowned destination.');
      }
    }
    for (const entry of input.entries.filter((entry) => entry.kind === 'directory').sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
      verifyRoot();
      await client.request({ action: 'create-directory', path: entry.path });
    }
    for (const entry of input.entries.filter((entry) => entry.kind === 'file')) {
      verifyRoot();
      await client.request({ action: 'restore-file', path: entry.path, originalPath: entry.path,
        entry, owner: owned.get(entry.path) || null });
    }
  } finally { await client.close(); }
  verifyGit(input);
  if (git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])) {
    throw new Error('Artifact restore destination changed source during publication.');
  }
  return { restoredFiles: input.entries.filter((entry) => entry.kind === 'file').length, bytes: totalBytes };
}
(async () => {
  try {
    const envelope = JSON.parse(await nextLine());
    rootIdentity = envelope.identity;
    verifyRoot();
    const input = envelope.request;
    const result = mode === 'revision' ? inspectRestoreRevision()
      : mode === 'capture' ? await capture(input) : mode === 'restore' ? await restore(input)
      : (() => { throw new Error('Artifact operation mode is invalid.'); })();
    process.stdout.write('O8_ARTIFACT_RESULT ' + Buffer.from(JSON.stringify(result)).toString('base64url') + '\n');
  } finally { fs.closeSync(rootFd); }
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
    process.execPath, ['-e', ARTIFACT_IO_SCRIPT, input.mode, artifactNodeScript()], input.identity,
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
    child.stdin.write(JSON.stringify({ request: input.request, identity: input.identity }) + '\n');
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
