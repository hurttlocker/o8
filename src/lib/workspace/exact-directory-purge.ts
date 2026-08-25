import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  removeExactEmptyChildDirectory,
  renameExactChildDirectory,
} from './exact-parent-operation';

export interface ExactDirectoryManifestEntry {
  relative: string;
  device: number;
  inode: number;
  kind: 'directory' | 'symlink' | 'file' | 'other';
  mode: number;
  linkCount: number;
}

export interface ExactDirectoryManifest {
  fingerprint: string;
  entries: ExactDirectoryManifestEntry[];
}

const PURGE_CAPTURE_SCRIPT = String.raw`
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');

async function manifestAt() {
  const entries = [];
  const pending = ['.'];
  while (pending.length > 0) {
    const relative = pending.pop();
    const stat = await fsp.lstat(relative);
    const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    entries.push({
      relative,
      device: stat.dev,
      inode: stat.ino,
      kind,
      mode: stat.mode,
      linkCount: stat.nlink,
    });
    if (kind === 'directory') {
      const names = (await fsp.readdir(relative)).sort().reverse();
      for (const name of names) pending.push(path.join(relative, name));
    }
  }
  return entries;
}

function inodeKey(entry) {
  return entry.kind === 'file' ? entry.device + ':' + entry.inode : '';
}

function countFileNames(manifest) {
  const counts = new Map();
  for (const entry of manifest) {
    if (entry.kind !== 'file') continue;
    const key = inodeKey(entry);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function childNamesByParent(manifest) {
  const names = new Map();
  for (const entry of manifest) {
    if (entry.relative === '.') continue;
    const parent = path.dirname(entry.relative);
    const children = names.get(parent) || [];
    children.push(path.basename(entry.relative));
    names.set(parent, children);
  }
  for (const children of names.values()) children.sort();
  return names;
}

function sameIdentity(actual, expected) {
  const kind = actual.isSymbolicLink() ? 'symlink' : actual.isDirectory() ? 'directory' : actual.isFile() ? 'file' : 'other';
  return actual.dev === expected.device && actual.ino === expected.inode && kind === expected.kind
    && (kind !== 'file' || actual.nlink === expected.linkCount);
}

function sameNamespaceIdentity(actual, expected) {
  const kind = actual.isSymbolicLink() ? 'symlink' : actual.isDirectory() ? 'directory' : actual.isFile() ? 'file' : 'other';
  return actual.dev === expected.device && actual.ino === expected.inode && kind === expected.kind;
}

function verifyMonotonicManifest(current, expected) {
  const expectedByPath = new Map(expected.map((entry) => [entry.relative, entry]));
  const currentPaths = new Set(current.map((entry) => entry.relative));
  const expectedFileNames = countFileNames(expected);
  const currentFileNames = countFileNames(current);
  for (const actual of current) {
    const prior = expectedByPath.get(actual.relative);
    if (!prior || actual.device !== prior.device || actual.inode !== prior.inode
      || actual.kind !== prior.kind) {
      throw new Error('Exact purge tree is not a monotonic subset of its durable manifest.');
    }
    if (actual.kind === 'file') {
      const key = inodeKey(prior);
      const originalNames = expectedFileNames.get(key) || 0;
      const remainingNames = currentFileNames.get(key) || 0;
      if (actual.linkCount !== prior.linkCount - (originalNames - remainingNames)) {
        throw new Error('Exact purge file link identity changed outside monotonic namespace release.');
      }
    }
    let parent = path.dirname(actual.relative);
    while (parent !== '.' && parent !== actual.relative) {
      if (!currentPaths.has(parent)) {
        throw new Error('Exact purge durable manifest has a detached descendant.');
      }
      parent = path.dirname(parent);
    }
  }
}

async function releaseContent(manifest) {
  const expectedChildNames = childNamesByParent(manifest);
  for (const expected of manifest) {
    const actual = await fsp.lstat(expected.relative);
    if (!sameIdentity(actual, expected)) throw new Error('Exact purge tree identity changed after capture.');
    if (expected.kind === 'directory') {
      const actualNames = (await fsp.readdir(expected.relative)).sort();
      const expectedNames = expectedChildNames.get(expected.relative) || [];
      if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
        throw new Error('Exact purge directory entries changed after capture.');
      }
    } else if (expected.kind === 'file') {
      // A local clone may share Git object inodes with its source. Those links
      // consume no clone-exclusive blocks, and truncating them would corrupt
      // the source repository, so retain the zero-cost link in the retired tree.
      if (expected.linkCount > 1) continue;
      const readHandle = await fsp.open(expected.relative, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const captured = await readHandle.stat();
        if (!sameIdentity(captured, expected)) throw new Error('Exact purge read handle captured a replacement.');
        await readHandle.chmod(expected.mode | 0o200);
      } finally {
        await readHandle.close();
      }
      const handle = await fsp.open(expected.relative, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
      try {
        const captured = await handle.stat();
        if (!sameIdentity(captured, expected)) throw new Error('Exact purge file handle captured a replacement.');
        await handle.truncate(0);
      } finally {
        await handle.close();
      }
    } else if (expected.kind === 'other') {
      throw new Error('Exact purge refuses non-file workspace entries.');
    }
  }
  for (const expected of manifest) {
    if (!sameIdentity(await fsp.lstat(expected.relative), expected)) {
      throw new Error('Exact purge tree identity changed during content release.');
    }
  }
  let releasedEntries = 0;
  for (const expected of [...manifest].reverse()) {
    if (expected.relative === '.') continue;
    const actual = await fsp.lstat(expected.relative);
    if (!sameNamespaceIdentity(actual, expected)) {
      throw new Error('Exact purge tree identity changed before namespace release.');
    }
    if (expected.kind === 'directory') await fsp.rmdir(expected.relative);
    else await fsp.unlink(expected.relative);
    releasedEntries += 1;
    if (releasedEntries === 1 && process.env.NODE_ENV === 'test'
      && process.env.O8_TEST_PURGE_STOP_MARKER) {
      fs.writeFileSync(process.env.O8_TEST_PURGE_STOP_MARKER, expected.relative, { flag: 'wx' });
      process.kill(process.pid, 'SIGSTOP');
    }
  }
  if ((await fsp.readdir('.')).length !== 0) {
    throw new Error('Exact purge namespace release left unexpected entries.');
  }
}

async function main() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const envelopeLine = await iterator.next();
  if (envelopeLine.done) throw new Error('Exact purge durable manifest input is absent.');
  const envelope = JSON.parse(envelopeLine.value);
  const expectedManifest = Array.isArray(envelope.entries) ? envelope.entries : [];
  const expectedDevice = Number(process.env.O8_PURGE_EXPECTED_DEVICE);
  const expectedInode = Number(process.env.O8_PURGE_EXPECTED_INODE);
  const captured = await fsp.lstat('.');
  if (!captured.isDirectory() || captured.isSymbolicLink()
    || captured.dev !== expectedDevice || captured.ino !== expectedInode) {
    throw new Error('Exact purge captured an unexpected directory identity.');
  }
  const manifest = await manifestAt();
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const expectedFingerprint = process.env.O8_PURGE_EXPECTED_FINGERPRINT || '';
  if (expectedManifest.length > 0) {
    verifyMonotonicManifest(manifest, expectedManifest);
  } else if (expectedFingerprint && fingerprint !== expectedFingerprint) {
    if (manifest.length !== 1 || manifest[0].relative !== '.' || (await fsp.readdir('.')).length !== 0) {
      throw new Error('Exact purge tree fingerprint changed before capture.');
    }
  }
  process.stdout.write('O8_PURGE_CAPTURED ' + fingerprint + '\n');
  process.stdout.write('O8_PURGE_MANIFEST ' + Buffer.from(JSON.stringify(manifest)).toString('base64url') + '\n');
  if (process.env.O8_PURGE_CAPTURE_ONLY === '1') return;
  const continuation = await iterator.next();
  if (continuation.done) throw new Error('Exact purge continuation was not authorized.');
  await releaseContent(manifest);
}
void main().catch((error) => {
  console.error('[exact-directory-purge]', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
`;

async function runCapturedPurge(
  candidatePath: string,
  identity: { device: number; inode: number },
  expectedFingerprint: string | undefined,
  expectedManifest: ExactDirectoryManifestEntry[] | undefined,
  afterTreeCapture?: (candidatePath: string) => Promise<void>,
): Promise<void> {
  const child = spawn(process.execPath, ['-e', PURGE_CAPTURE_SCRIPT], {
    cwd: candidatePath,
    env: {
      ...process.env,
      O8_PURGE_EXPECTED_DEVICE: String(identity.device),
      O8_PURGE_EXPECTED_INODE: String(identity.inode),
      ...(expectedFingerprint ? { O8_PURGE_EXPECTED_FINGERPRINT: expectedFingerprint } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdin.write(`${JSON.stringify({ entries: expectedManifest ?? [] })}\n`);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Exact purge capture timed out.')), 60_000);
    const inspect = () => {
      if (/O8_PURGE_CAPTURED [0-9a-f]{64}\n/.test(stdout)) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on('data', inspect);
    void closed.then((code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(stderr.trim() || 'Exact purge capture failed.'));
      }
    });
  });
  try {
    await afterTreeCapture?.(candidatePath);
  } finally {
    child.stdin.end('continue\n');
  }
  const code = await closed;
  if (code !== 0) throw new Error(stderr.trim() || 'Exact purge content release failed.');
}

/** Capture the exact descendant inode set before content verification begins. */
export async function captureExactDirectoryManifestFingerprint(
  candidatePath: string,
  identity: { device: number; inode: number },
): Promise<string> {
  return (await captureExactDirectoryManifest(candidatePath, identity)).fingerprint;
}

/** Capture the exact descendant inode set used for crash-safe monotonic release. */
export async function captureExactDirectoryManifest(
  candidatePath: string,
  identity: { device: number; inode: number },
): Promise<ExactDirectoryManifest> {
  const child = spawn(process.execPath, ['-e', PURGE_CAPTURE_SCRIPT], {
    cwd: candidatePath,
    env: {
      ...process.env,
      O8_PURGE_EXPECTED_DEVICE: String(identity.device),
      O8_PURGE_EXPECTED_INODE: String(identity.inode),
      O8_PURGE_CAPTURE_ONLY: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdin.end('{"entries":[]}\n');
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  const match = /O8_PURGE_CAPTURED ([0-9a-f]{64})\n/.exec(stdout);
  const manifestMatch = /O8_PURGE_MANIFEST ([A-Za-z0-9_-]+)\n/.exec(stdout);
  if (code !== 0 || !match?.[1] || !manifestMatch?.[1]) {
    throw new Error(stderr.trim() || 'Exact purge tree fingerprint capture failed.');
  }
  const entries = JSON.parse(Buffer.from(manifestMatch[1], 'base64url').toString('utf8')) as unknown;
  if (!Array.isArray(entries)) throw new Error('Exact purge tree manifest capture is invalid.');
  return { fingerprint: match[1], entries: entries as ExactDirectoryManifestEntry[] };
}

/** Release receipted file bytes and namespace entries through captured cwd boundaries. */
export async function purgeExactDirectory(
  candidatePath: string,
  identity: { device: number; inode: number },
  beforeCapture?: (candidatePath: string) => Promise<void>,
  afterTreeCapture?: (candidatePath: string) => Promise<void>,
  afterContentRelease?: (candidatePath: string) => Promise<void>,
  expectedFingerprint?: string,
  expectedManifest?: ExactDirectoryManifestEntry[],
): Promise<void> {
  const parentPath = path.dirname(candidatePath);
  const parentStat = await lstat(parentPath);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('Exact purge parent is not a regular directory.');
  }
  const parentIdentity = {
    device: parentStat.dev,
    inode: parentStat.ino,
    canonicalPath: await realpath(parentPath),
  };
  await beforeCapture?.(candidatePath);
  await runCapturedPurge(
    candidatePath,
    identity,
    expectedFingerprint,
    expectedManifest,
    afterTreeCapture,
  );
  await afterContentRelease?.(candidatePath);
  const retiredPath = path.join(
    parentPath,
    `.o8-retired-tree-${path.basename(candidatePath)}-${randomUUID()}`,
  );
  await renameExactChildDirectory(
    parentPath,
    parentIdentity,
    candidatePath,
    retiredPath,
    identity,
  );
  const moved = await lstat(retiredPath);
  if (!moved.isDirectory() || moved.isSymbolicLink()
    || moved.dev !== identity.device || moved.ino !== identity.inode) {
    throw new Error('Exact purge retirement moved an unexpected directory identity.');
  }
  await removeExactEmptyChildDirectory(parentPath, parentIdentity, retiredPath, identity);
  await Promise.all((await readdir(parentPath))
    .filter((name) => name.startsWith('.o8-retired-tree-'))
    .map(async (name) => {
      const candidate = path.join(parentPath, name);
      const stat = await lstat(candidate).catch(() => null);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
      await removeExactEmptyChildDirectory(
        parentPath,
        parentIdentity,
        candidate,
        { device: stat.dev, inode: stat.ino },
      ).catch(() => undefined);
    }));
}
