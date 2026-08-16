import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  guardedWorkspaceInvocation,
} from './materialization-execution';
import type { WorktreeMaterializationIdentity } from './materialization-identity';

export class PinnedWorkspacePublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PinnedWorkspacePublishError';
  }
}

export function isPinnedWorkspacePublishError(error: unknown): boolean {
  return error instanceof PinnedWorkspacePublishError;
}

const PINNED_LEAF_IO_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function safeRelative(value) {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error('Pinned workspace path is unsafe.');
  }
  return normalized;
}

async function waitForStep(name) {
  if (process.env.O8_PINNED_STEP_HANDSHAKE !== '1') return;
  process.stdout.write('O8_PINNED_STEP ' + Buffer.from(name).toString('base64url') + '\n');
  await new Promise((resolve, reject) => {
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
    process.stdin.once('error', reject);
    process.stdin.resume();
  });
}

async function prepareParent(relative, createMissing = true) {
  const parts = safeRelative(relative).split('/');
  const leaf = parts.pop();
  const canonicalRoot = fs.realpathSync('.');
  for (const part of parts) {
    let entry;
    try {
      entry = fs.lstatSync(part);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!createMissing) throw error;
      fs.mkdirSync(part);
      entry = fs.lstatSync(part);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Pinned workspace destination has an unsafe ancestor.');
    }
    await waitForStep(part);
    process.chdir(part);
    const captured = fs.lstatSync('.');
    const canonical = fs.realpathSync('.');
    const relativeCanonical = path.relative(canonicalRoot, canonical);
    if (!captured.isDirectory() || captured.isSymbolicLink()
      || captured.dev !== entry.dev || captured.ino !== entry.ino
      || relativeCanonical.startsWith('..') || path.isAbsolute(relativeCanonical)) {
      throw new Error('Pinned workspace ancestor changed during capture.');
    }
  }
  return { parent: '.', leaf, target: leaf };
}

function readExactHandle(handle, size) {
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = fs.readSync(handle, content, offset, size - offset, offset);
    if (read === 0) throw new Error('Pinned workspace file ended before its receipt.');
    offset += read;
  }
  return content;
}

async function copyFileExact(sourcePath, targetPath) {
  const source = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let target;
  try {
    const before = fs.fstatSync(source);
    if (!before.isFile()) throw new Error('Pinned workspace source is not a regular file.');
    const content = readExactHandle(source, before.size);
    await waitForStep('copy-file-read');
    const repeated = readExactHandle(source, before.size);
    const after = fs.fstatSync(source);
    if (after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || (after.mode & 0o777) !== (before.mode & 0o777)
      || !content.equals(repeated)) {
      throw new Error('Pinned workspace source file changed during copy.');
    }
    target = fs.openSync(
      targetPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      before.mode & 0o777,
    );
    const targetIdentity = fs.fstatSync(target);
    await waitForStep('copy-file-opened');
    const namedTarget = fs.lstatSync(targetPath);
    if (targetIdentity.nlink !== 1
      || !namedTarget.isFile() || namedTarget.isSymbolicLink()
      || namedTarget.dev !== targetIdentity.dev || namedTarget.ino !== targetIdentity.ino) {
      throw new Error('Pinned workspace copied target is not exclusively linked.');
    }
    fs.writeFileSync(target, content);
    fs.fsyncSync(target);
    const published = fs.fstatSync(target);
    const publishedName = fs.lstatSync(targetPath);
    if (published.nlink !== 1 || published.size !== content.length
      || (published.mode & 0o777) !== (before.mode & 0o777)
      || !readExactHandle(target, published.size).equals(content)
      || !publishedName.isFile() || publishedName.isSymbolicLink()
      || publishedName.dev !== published.dev || publishedName.ino !== published.ino) {
      throw new Error('Pinned workspace target did not match its source receipt.');
    }
  } finally {
    if (target !== undefined) fs.closeSync(target);
    fs.closeSync(source);
  }
}

async function copyTree(sourcePath, targetPath) {
  const source = fs.lstatSync(sourcePath);
  if (source.isSymbolicLink()) throw new Error('Pinned hydration refuses source symlinks.');
  await waitForStep('source');
  let reproved;
  try {
    reproved = fs.lstatSync(sourcePath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Pinned hydration source changed after capture.');
    throw error;
  }
  if (reproved.isSymbolicLink() || reproved.dev !== source.dev || reproved.ino !== source.ino) {
    throw new Error('Pinned hydration source changed after capture.');
  }
  if (source.isFile()) {
    const handle = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const captured = fs.fstatSync(handle);
      if (!captured.isFile() || captured.dev !== source.dev || captured.ino !== source.ino) {
        throw new Error('Pinned hydration source file changed before capture.');
      }
      const target = fs.openSync(
        targetPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        source.mode & 0o777,
      );
      try {
        if (fs.fstatSync(target).nlink !== 1) {
          throw new Error('Pinned hydration target file is not exclusively linked.');
        }
        fs.writeFileSync(target, fs.readFileSync(handle));
        fs.fsyncSync(target);
        if (fs.fstatSync(target).nlink !== 1) {
          throw new Error('Pinned hydration target file gained another link during copy.');
        }
      } finally {
        fs.closeSync(target);
      }
      const after = fs.fstatSync(handle);
      if (after.dev !== captured.dev || after.ino !== captured.ino
        || after.size !== captured.size || after.mtimeMs !== captured.mtimeMs) {
        throw new Error('Pinned hydration source file changed during copy.');
      }
    } finally {
      fs.closeSync(handle);
    }
    return;
  }
  if (!source.isDirectory()) throw new Error('Pinned hydration source has an unsupported entry.');
  fs.mkdirSync(targetPath, source.mode & 0o777);
  const names = fs.readdirSync(sourcePath).sort();
  for (const name of names) {
    await copyTree(path.join(sourcePath, name), path.join(targetPath, name));
  }
  const after = fs.lstatSync(sourcePath);
  if (!after.isDirectory() || after.isSymbolicLink()
    || after.dev !== source.dev || after.ino !== source.ino
    || JSON.stringify(fs.readdirSync(sourcePath).sort()) !== JSON.stringify(names)) {
    throw new Error('Pinned hydration source directory changed during copy.');
  }
}

function fingerprintTree(candidatePath, relative = '.') {
  const hash = crypto.createHash('sha256');
  const visit = (entryPath, entryRelative) => {
    const entry = fs.lstatSync(entryPath);
    if (entry.isSymbolicLink()) throw new Error('Pinned hydration refuses source symlinks.');
    if (entry.isFile()) {
      const handle = fs.openSync(entryPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const captured = fs.fstatSync(handle);
        if (!captured.isFile() || captured.dev !== entry.dev || captured.ino !== entry.ino) {
          throw new Error('Pinned hydration source file changed during fingerprint.');
        }
        hash.update('file\0' + entryRelative + '\0' + (entry.mode & 0o777).toString(8) + '\0');
        hash.update(fs.readFileSync(handle));
        const after = fs.fstatSync(handle);
        if (after.dev !== captured.dev || after.ino !== captured.ino
          || after.size !== captured.size || after.mtimeMs !== captured.mtimeMs) {
          throw new Error('Pinned hydration source file changed during fingerprint.');
        }
      } finally {
        fs.closeSync(handle);
      }
      return;
    }
    if (!entry.isDirectory()) throw new Error('Pinned hydration source has an unsupported entry.');
    const names = fs.readdirSync(entryPath).sort();
    hash.update('directory\0' + entryRelative + '\0'
      + (entry.mode & 0o777).toString(8) + '\0' + JSON.stringify(names) + '\0');
    for (const name of names) {
      visit(path.join(entryPath, name), entryRelative === '.' ? name : path.join(entryRelative, name));
    }
    const after = fs.lstatSync(entryPath);
    if (!after.isDirectory() || after.isSymbolicLink()
      || after.dev !== entry.dev || after.ino !== entry.ino
      || JSON.stringify(fs.readdirSync(entryPath).sort()) !== JSON.stringify(names)) {
      throw new Error('Pinned hydration source directory changed during fingerprint.');
    }
  };
  visit(candidatePath, relative);
  return hash.digest('hex');
}

async function main() {
  const operation = process.argv[1];
  const relative = process.argv[2];
  let prepared;
  try {
    prepared = await prepareParent(relative, operation !== 'read' && operation !== 'inspect-entry');
  } catch (error) {
    if ((operation === 'read' || operation === 'inspect-entry') && error.code === 'ENOENT') {
      process.exitCode = 44;
      return;
    }
    throw error;
  }
  if (operation === 'read') {
    try {
      const handle = fs.openSync(prepared.target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const identity = fs.fstatSync(handle);
        if (!identity.isFile() || identity.nlink !== 1) {
          throw new Error('Pinned workspace target is not an exclusive regular file.');
        }
        process.stdout.write(JSON.stringify({
          content: fs.readFileSync(handle).toString('base64'),
          device: identity.dev,
          inode: identity.ino,
        }));
      } finally {
        fs.closeSync(handle);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      process.exitCode = 44;
    }
    return;
  }
  if (operation === 'inspect-entry') {
    try {
      const entry = fs.lstatSync(prepared.target);
      const kind = entry.isSymbolicLink() ? 'symlink'
        : entry.isDirectory() ? 'directory'
        : entry.isFile() ? 'file'
        : 'other';
      process.stdout.write(JSON.stringify({ kind, device: entry.dev, inode: entry.ino }));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      process.exitCode = 44;
    }
    return;
  }
  if (operation === 'atomic-write') {
    const injectedContent = process.env.O8_PINNED_ATOMIC_CONTENT;
    const content = injectedContent === undefined
      ? Buffer.concat(await Array.fromAsync(process.stdin))
      : Buffer.from(injectedContent, 'base64');
    let handle;
    const expectedTarget = process.env.O8_PINNED_EXPECTED_TARGET;
    if (expectedTarget === 'null') {
      handle = fs.openSync(
        prepared.target,
        fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
    } else {
      try {
        handle = fs.openSync(prepared.target, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
      } catch (error) {
        if (error.code !== 'ENOENT' || expectedTarget !== undefined) throw error;
        handle = fs.openSync(
          prepared.target,
          fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
          0o600,
        );
      }
    }
    const receipt = fs.fstatSync(handle);
    if (!receipt.isFile() || receipt.nlink !== 1) {
      fs.closeSync(handle);
      throw new Error('Pinned workspace direct-write target is not exclusively linked.');
    }
    if (expectedTarget && expectedTarget !== 'null') {
      const expected = JSON.parse(expectedTarget);
      if (receipt.dev !== expected.device || receipt.ino !== expected.inode) {
        fs.closeSync(handle);
        throw new Error('Pinned workspace direct-write target does not match its durable receipt.');
      }
    }
    await waitForStep('atomic-opened');
    try {
      const named = fs.lstatSync(prepared.target);
      if (!named.isFile() || named.isSymbolicLink()
        || named.nlink !== 1
        || named.dev !== receipt.dev || named.ino !== receipt.ino
        || fs.fstatSync(handle).nlink !== 1) {
        throw new Error('Pinned workspace target changed before direct write.');
      }
      fs.ftruncateSync(handle, 0);
      fs.writeSync(handle, content, 0, content.length, 0);
      fs.fsyncSync(handle);
      const current = fs.fstatSync(handle);
      const persisted = fs.readFileSync(handle);
      const published = fs.lstatSync(prepared.target);
      if (!current.isFile() || current.nlink !== 1
        || current.dev !== receipt.dev || current.ino !== receipt.ino
        || current.size !== content.length
        || crypto.createHash('sha256').update(persisted).digest('hex')
          !== crypto.createHash('sha256').update(content).digest('hex')
        || !published.isFile() || published.isSymbolicLink()
        || published.dev !== receipt.dev || published.ino !== receipt.ino) {
        throw new Error('Pinned workspace direct write lost its exact target.');
      }
      process.stdout.write(JSON.stringify({ device: receipt.dev, inode: receipt.ino }));
    } finally {
      fs.closeSync(handle);
    }
    return;
  }
  if (operation === 'ensure-directory') {
    let before;
    try {
      before = fs.lstatSync(prepared.target);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(prepared.target);
      before = fs.lstatSync(prepared.target);
    }
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error('Pinned workspace directory target is unsafe.');
    }
    await waitForStep(prepared.leaf);
    process.chdir(prepared.target);
    const captured = fs.lstatSync('.');
    const canonicalPath = fs.realpathSync('.');
    if (!captured.isDirectory() || captured.isSymbolicLink()
      || captured.dev !== before.dev || captured.ino !== before.ino) {
      throw new Error('Pinned workspace directory changed during capture.');
    }
    process.stdout.write(JSON.stringify({
      canonicalPath, device: captured.dev, inode: captured.ino,
    }));
    return;
  }
  if (operation === 'ensure-file') {
    const injectedContent = process.env.O8_PINNED_ENSURE_CONTENT;
    const expected = injectedContent === undefined
      ? Buffer.concat(await Array.fromAsync(process.stdin))
      : Buffer.from(injectedContent, 'base64');
    let created = false;
    let handle;
    try {
      handle = fs.openSync(prepared.target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      handle = fs.openSync(
        prepared.target,
        fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
    }
    try {
      const receipt = fs.fstatSync(handle);
      if (!receipt.isFile() || receipt.nlink !== 1) {
        throw new Error('Pinned workspace ensured target is not exclusively linked.');
      }
      await waitForStep('ensure-file-opened');
      if (created) {
        fs.writeSync(handle, expected, 0, expected.length, 0);
        fs.fsyncSync(handle);
      }
      const actual = Buffer.alloc(expected.length);
      fs.readSync(handle, actual, 0, actual.length, 0);
      const after = fs.fstatSync(handle);
      if (!actual.equals(expected) || after.nlink !== 1 || after.size !== expected.length) {
        throw new Error('Pinned workspace ensured file has unexpected contents.');
      }
      const published = fs.lstatSync(prepared.target);
      if (!published.isFile() || published.isSymbolicLink()
        || published.nlink !== 1
        || published.dev !== receipt.dev || published.ino !== receipt.ino) {
        throw new Error('Pinned workspace publish moved an unexpected ensured file.');
      }
    } finally {
      fs.closeSync(handle);
    }
    return;
  }
  try {
    fs.lstatSync(prepared.target);
    process.exitCode = 45;
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (operation === 'copy-file') await copyFileExact(process.argv[3], prepared.target);
  else if (operation === 'symlink') {
    fs.symlinkSync(process.argv[3], prepared.target);
    const receipt = fs.lstatSync(prepared.target);
    await waitForStep('symlink-created');
    const published = fs.lstatSync(prepared.target);
    if (!receipt.isSymbolicLink() || receipt.nlink !== 1
      || !published.isSymbolicLink() || published.nlink !== 1
      || published.dev !== receipt.dev || published.ino !== receipt.ino
      || fs.readlinkSync(prepared.target) !== process.argv[3]) {
      throw new Error('Pinned workspace symlink target changed before its receipt.');
    }
  }
  else if (operation === 'copy-tree') {
    const sourcePath = process.argv[3];
    const sourceFingerprint = fingerprintTree(sourcePath);
    const sourceIdentity = fs.lstatSync(sourcePath);
    if (!sourceIdentity.isDirectory() || sourceIdentity.isSymbolicLink()) {
      throw new Error('Pinned hydration tree source is not a directory.');
    }
    await waitForStep('source-reproved');
    fs.mkdirSync(prepared.target, sourceIdentity.mode & 0o777);
    const targetIdentity = fs.lstatSync(prepared.target);
    const publicTarget = path.join(process.cwd(), prepared.target);
    await waitForStep('target-created');
    process.chdir(prepared.target);
    const capturedTarget = fs.lstatSync('.');
    if (!capturedTarget.isDirectory() || capturedTarget.isSymbolicLink()
      || capturedTarget.dev !== targetIdentity.dev || capturedTarget.ino !== targetIdentity.ino) {
      throw new Error('Pinned hydration target changed before population.');
    }
    const names = fs.readdirSync(sourcePath).sort();
    for (const name of names) {
      await copyTree(path.join(sourcePath, name), name);
    }
    await waitForStep('source-copied');
    if (fingerprintTree(sourcePath) !== sourceFingerprint
      || fingerprintTree('.') !== sourceFingerprint) {
      throw new Error('Pinned hydration source changed during direct population.');
    }
    const publishedIdentity = fs.lstatSync(publicTarget);
    if (!publishedIdentity.isDirectory() || publishedIdentity.isSymbolicLink()
      || publishedIdentity.dev !== targetIdentity.dev
      || publishedIdentity.ino !== targetIdentity.ino) {
      throw new Error('Pinned hydration direct target lost its exact namespace.');
    }
  }
  else throw new Error('Pinned workspace operation is unsupported.');
}

void main().then(() => {
  process.stdin.destroy();
}).catch((error) => {
  process.stdin.destroy();
  console.error('[workspace-materialization] ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
`;

function safeRelativePath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe pinned workspace path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

async function runPinnedLeaf(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  operation: 'read' | 'inspect-entry' | 'atomic-write' | 'copy-file' | 'symlink' | 'copy-tree' | 'ensure-directory' | 'ensure-file',
  relativePath: string,
  sourceOrTarget?: string,
  content?: string,
  afterPinnedStep?: (segment: string) => Promise<void>,
  expectedTargetIdentity?: { device: number; inode: number } | null,
): Promise<{ code: number; stdout: string }> {
  const invocation = guardedWorkspaceInvocation(process.execPath, [
    '-e', PINNED_LEAF_IO_SCRIPT, operation, safeRelativePath(relativePath),
    ...(sourceOrTarget ? [sourceOrTarget] : []),
  ], identity);
  const child = spawn(invocation.command, invocation.args, {
    cwd: workspacePath,
    env: {
      ...process.env,
      ...(afterPinnedStep ? { O8_PINNED_STEP_HANDSHAKE: '1' } : {}),
      ...(afterPinnedStep && operation === 'atomic-write'
        ? { O8_PINNED_ATOMIC_CONTENT: Buffer.from(content ?? '').toString('base64') }
        : {}),
      ...(afterPinnedStep && operation === 'ensure-file'
        ? { O8_PINNED_ENSURE_CONTENT: Buffer.from(content ?? '').toString('base64') }
        : {}),
      ...(operation === 'atomic-write' && expectedTargetIdentity !== undefined
        ? { O8_PINNED_EXPECTED_TARGET: JSON.stringify(expectedTargetIdentity) }
        : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let pendingStdout = '';
  let stepQueue = Promise.resolve();
  child.stdout.on('data', (chunk: Buffer) => {
    pendingStdout += chunk.toString('utf8');
    if (!afterPinnedStep) return;
    for (;;) {
      const newline = pendingStdout.indexOf('\n');
      if (newline < 0) break;
      const line = pendingStdout.slice(0, newline);
      pendingStdout = pendingStdout.slice(newline + 1);
      const match = /^O8_PINNED_STEP ([A-Za-z0-9_-]+)$/.exec(line);
      if (!match?.[1]) {
        stdout += `${line}\n`;
        continue;
      }
      const segment = Buffer.from(match[1], 'base64url').toString('utf8');
      stepQueue = stepQueue.then(() => afterPinnedStep(segment)).then(() => {
        child.stdin.write('continue\n');
      });
    }
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  if (!afterPinnedStep) child.stdin.end(content ?? '');
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  await stepQueue;
  child.stdin.end();
  stdout += pendingStdout;
  if (code === null) throw new Error('Pinned workspace operation ended without an exit receipt.');
  if (code !== 0 && code !== 44 && code !== 45) {
    const message = stderr.trim() || 'Pinned workspace operation failed.';
    if (operation === 'copy-tree'
      || (operation === 'copy-file'
        && (message.includes('copied target') || message.includes('target did not match')))
      || (operation === 'symlink' && message.includes('symlink target changed'))
      || message.includes('publish moved an unexpected')
      || message.includes('direct write lost its exact target')
      || message.includes('direct-write target is not exclusively linked')
      || message.includes('target changed before direct write')
      || message.includes('hydration target changed before population')
      || message.includes('hydration direct target lost its exact namespace')
      || message.includes('hydration source changed')) {
      throw new PinnedWorkspacePublishError(message);
    }
    throw new Error(message);
  }
  return { code, stdout };
}

export async function readPinnedWorkspaceFile(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  relativePath: string,
): Promise<string | null> {
  const receipt = await readPinnedWorkspaceFileReceipt(workspacePath, identity, relativePath);
  return receipt?.content ?? null;
}

export async function readPinnedWorkspaceFileReceipt(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  relativePath: string,
): Promise<{ content: string; device: number; inode: number } | null> {
  const receipt = await runPinnedLeaf(workspacePath, identity, 'read', relativePath);
  if (receipt.code === 44) return null;
  const parsed = JSON.parse(receipt.stdout) as {
    content?: unknown; device?: unknown; inode?: unknown;
  };
  if (typeof parsed.content !== 'string'
    || !Number.isSafeInteger(parsed.device)
    || !Number.isSafeInteger(parsed.inode)) {
    throw new Error('Pinned workspace read returned an invalid file receipt.');
  }
  return {
    content: Buffer.from(parsed.content, 'base64').toString('utf8'),
    device: parsed.device as number,
    inode: parsed.inode as number,
  };
}

export async function inspectPinnedWorkspaceEntry(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  relativePath: string,
): Promise<{ kind: 'file' | 'directory' | 'symlink' | 'other'; device: number; inode: number } | null> {
  const receipt = await runPinnedLeaf(workspacePath, identity, 'inspect-entry', relativePath);
  if (receipt.code === 44) return null;
  const parsed = JSON.parse(receipt.stdout) as {
    kind?: unknown; device?: unknown; inode?: unknown;
  };
  if ((parsed.kind !== 'file' && parsed.kind !== 'directory'
      && parsed.kind !== 'symlink' && parsed.kind !== 'other')
    || !Number.isSafeInteger(parsed.device) || !Number.isSafeInteger(parsed.inode)) {
    throw new Error('Pinned workspace inspection returned an invalid identity.');
  }
  return parsed as { kind: 'file' | 'directory' | 'symlink' | 'other'; device: number; inode: number };
}

export async function writePinnedWorkspaceFile(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  relativePath: string,
  content: string,
  afterPinnedStep?: (segment: string) => Promise<void>,
  expectedTargetIdentity?: { device: number; inode: number } | null,
): Promise<{ device: number; inode: number }> {
  const receipt = await runPinnedLeaf(
    workspacePath, identity, 'atomic-write', relativePath, undefined, content, afterPinnedStep,
    expectedTargetIdentity,
  );
  const parsed = JSON.parse(receipt.stdout) as { device?: unknown; inode?: unknown };
  if (!Number.isSafeInteger(parsed.device) || !Number.isSafeInteger(parsed.inode)) {
    throw new Error('Pinned workspace direct write returned an invalid target receipt.');
  }
  return { device: parsed.device as number, inode: parsed.inode as number };
}

export async function ensurePinnedWorkspaceFile(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  relativePath: string,
  content: string,
  afterPinnedStep?: (segment: string) => Promise<void>,
): Promise<void> {
  await runPinnedLeaf(
    workspacePath, identity, 'ensure-file', relativePath, undefined, content, afterPinnedStep,
  );
}

export async function createPinnedWorkspaceBinding(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  relativePath: string,
  input: { mode: 'copy-file' | 'symlink' | 'copy-tree'; source: string },
  afterPinnedStep?: (segment: string) => Promise<void>,
): Promise<'created' | 'exists'> {
  const receipt = await runPinnedLeaf(
    workspacePath, identity, input.mode, relativePath, input.source, undefined, afterPinnedStep,
  );
  return receipt.code === 45 ? 'exists' : 'created';
}

export async function ensurePinnedWorkspaceDirectory(
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  relativePath: string,
  afterPinnedStep?: (segment: string) => Promise<void>,
): Promise<WorktreeMaterializationIdentity> {
  const receipt = await runPinnedLeaf(
    workspacePath, identity, 'ensure-directory', relativePath, undefined, undefined, afterPinnedStep,
  );
  const parsed = JSON.parse(receipt.stdout) as Partial<WorktreeMaterializationIdentity>;
  if (!Number.isSafeInteger(parsed.device)
    || !Number.isSafeInteger(parsed.inode)
    || typeof parsed.canonicalPath !== 'string'
    || !path.isAbsolute(parsed.canonicalPath)) {
    throw new Error('Pinned workspace directory returned an invalid identity.');
  }
  return parsed as WorktreeMaterializationIdentity;
}
