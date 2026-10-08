import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { laneGitArguments, laneGitEnvironment, laneGitInvocation } from '@/lib/lane/lane-git';
import { getDataDir } from '@/lib/data-dir-migration';
import {
  assertWorktreeMaterializationIdentity,
  captureWorktreeMaterializationIdentity,
  type WorktreeMaterializationIdentity,
} from '@/lib/worktree/materialization-identity';
import { guardedWorkspaceInvocation, materializationAwareExecFile, withWorktreeMaterializationExecution } from '@/lib/worktree/materialization-execution';
import type { WorkspaceSnapshotRecord } from '@/lib/worktree/snapshot-state';

const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

export interface WorkspaceGitBundleReceipt {
  schema: 'o8/workspace-git-bundle/v1';
  sha256: string;
  bytes: number;
  objectFormat: 'sha1' | 'sha256';
  repositoryUuid: string;
  packetId: string;
  snapshotGeneration: number;
  snapshotFingerprint: string;
  headCommit: string;
  treeSha: string;
  recoveryRef: string;
  prerequisiteCount: 0;
  commitCount: number;
  objectCount: number;
}

const gitEnvironment = () => laneGitEnvironment(true);

async function privateDirectory(directory: string): Promise<WorktreeMaterializationIdentity> {
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid()) || await realpath(directory) !== directory) {
    throw new Error('The private Git preservation directory has unsafe ownership.');
  }
  return captureWorktreeMaterializationIdentity(directory);
}

async function bundleDirectory() {
  const data = await realpath(getDataDir());
  const bank = path.join(data, 'workspace-preservation');
  const bankIdentity = await privateDirectory(bank);
  const directory = path.join(bank, 'git-bundles');
  const identity = await privateDirectory(directory);
  await assertWorktreeMaterializationIdentity(bank, bankIdentity);
  return { directory, identity, bankIdentity };
}

async function assertBank(bank: Awaited<ReturnType<typeof bundleDirectory>>) {
  await assertWorktreeMaterializationIdentity(path.dirname(bank.directory), bank.bankIdentity);
  await assertWorktreeMaterializationIdentity(bank.directory, bank.identity);
}

function sameFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mode === after.mode && before.uid === after.uid && before.nlink === after.nlink
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function readBundleFile(candidate: string): Promise<{ content: Buffer; stat: Stats; sha256: string }> {
  const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_BUNDLE_BYTES
      || (before.mode & 0o077) !== 0 || (process.getuid && before.uid !== process.getuid())) {
      throw new Error('The Git bundle exceeds its bound or has unsafe file ownership.');
    }
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await file.read(content, offset, content.length - offset, offset);
      if (!bytesRead) throw new Error('The Git bundle changed during descriptor read.');
      offset += bytesRead;
    }
    const after = await file.stat();
    const named = await lstat(candidate);
    if (!sameFile(before, after) || !sameFile(after, named) || named.isSymbolicLink()) {
      throw new Error('The private Git bundle changed during receipt verification.');
    }
    return { content, stat: after, sha256: createHash('sha256').update(content).digest('hex') };
  } finally {
    await file.close();
  }
}

export async function readWorkspaceGitBundle(receipt: WorkspaceGitBundleReceipt): Promise<Buffer> {
  const oid = receipt.objectFormat === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
  if (receipt.schema !== 'o8/workspace-git-bundle/v1' || !/^[a-f0-9]{64}$/.test(receipt.sha256)
    || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1 || receipt.bytes > MAX_BUNDLE_BYTES
    || !['sha1', 'sha256'].includes(receipt.objectFormat) || !oid.test(receipt.headCommit) || !oid.test(receipt.treeSha)
    || !Number.isSafeInteger(receipt.commitCount) || receipt.commitCount < 1
    || !Number.isSafeInteger(receipt.objectCount) || receipt.objectCount < receipt.commitCount
    || receipt.prerequisiteCount !== 0 || !Number.isSafeInteger(receipt.snapshotGeneration) || receipt.snapshotGeneration < 1
    || !receipt.recoveryRef.startsWith('refs/o8/recovery/')) {
    throw new Error('The portable Git bundle receipt is invalid.');
  }
  const bank = await bundleDirectory();
  const result = await readBundleFile(path.join(bank.directory, receipt.sha256 + '.bundle'));
  await assertBank(bank);
  if (result.sha256 !== receipt.sha256 || result.content.length !== receipt.bytes) {
    throw new Error('The portable Git bundle failed its trusted hash or size receipt.');
  }
  return result.content;
}

async function gitValue(cwd: string, identity: WorktreeMaterializationIdentity, args: string[]): Promise<string> {
  return withWorktreeMaterializationExecution(cwd, identity, async () => {
    // Private empty verifiers have no lane metadata or configured drivers.
    const invocation = args[0] === 'init' || args[0]?.startsWith('--git-dir=verify.git')
      ? { args: laneGitArguments(args), env: gitEnvironment() }
      : laneGitInvocation(cwd, cwd, args, true);
    const { stdout } = await materializationAwareExecFile('git', invocation.args, {
      cwd, env: invocation.env, timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
    });
    return stdout.trim();
  });
}

// Each process receives an OS-captured cwd. macOS cannot traverse directory
// descriptors through /dev/fd; only the regular bundle descriptor crosses cwd boundaries.
const PREPARE_DIRECTORY = String.raw`
const fs = require('node:fs');
const leaf = fs.mkdtempSync('.prepare-');
const stat = fs.lstatSync(leaf);
if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)
  || (process.getuid && stat.uid !== process.getuid())) throw new Error('Verifier ownership is unsafe.');
process.stdout.write(JSON.stringify({ leaf, device: stat.dev, inode: stat.ino }));
`;

const CAPTURE_BUNDLE = String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const input = JSON.parse(process.argv[1]);
const fd = fs.openSync('source.bundle', fs.constants.O_WRONLY | fs.constants.O_CREAT
  | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
const child = spawn(input.invocation.command, input.invocation.args, {
  cwd: input.repositoryPath, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let bytes = 0;
let stderrBytes = 0;
const abort = () => child.kill();
process.once('SIGTERM', abort);
child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; if (stderrBytes > 1024 * 1024) abort(); });
const timer = setTimeout(abort, 120000);
const completed = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code) => code === 0 ? resolve() : reject(new Error('Portable Git bundle creation failed.')));
});
const written = pipeline(child.stdout, new Writable({
  write(chunk, _encoding, callback) {
    try {
      bytes += chunk.length;
      if (bytes > input.maxBytes) throw new Error('Portable Git source exceeds the bounded preservation budget.');
      let offset = 0;
      while (offset < chunk.length) {
        const count = fs.writeSync(fd, chunk, offset, chunk.length - offset);
        if (!count) throw new Error('Portable Git bundle descriptor write was incomplete.');
        offset += count;
      }
      callback();
    } catch (error) { callback(error); }
  },
}));
(async () => {
  try { await Promise.all([completed, written]); fs.fsyncSync(fd); }
  catch (error) { abort(); await Promise.allSettled([completed, written]); throw error; }
  finally { clearTimeout(timer); process.removeListener('SIGTERM', abort); fs.closeSync(fd); }
})().catch((error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
`;

async function createBundle(snapshot: WorkspaceSnapshotRecord, repositoryPath: string,
  repositoryIdentity: WorktreeMaterializationIdentity, preparation: string, identity: WorktreeMaterializationIdentity) {
  const safe = laneGitInvocation(repositoryPath, repositoryPath, [
    'bundle', 'create', '--version=3', '-', snapshot.recoveryRef,
  ], true);
  const invocation = guardedWorkspaceInvocation('git', safe.args, repositoryIdentity);
  await withWorktreeMaterializationExecution(preparation, identity, () => materializationAwareExecFile(
    process.execPath, ['-e', CAPTURE_BUNDLE, JSON.stringify({ invocation, repositoryPath, maxBytes: MAX_BUNDLE_BYTES })],
    { cwd: preparation, env: safe.env, timeout: 125_000, maxBuffer: 1024 * 1024 },
  ));
}

const PUBLISH_FROM_DESCRIPTOR = String.raw`
const fs = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const input = JSON.parse(process.argv[1]);
const directory = fs.lstatSync('.');
if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)
  || (process.getuid && directory.uid !== process.getuid())
  || directory.dev !== input.bankIdentity.device || directory.ino !== input.bankIdentity.inode
  || fs.realpathSync('.') !== input.bankIdentity.canonicalPath) {
  throw new Error('Captured publication bank ownership changed.');
}
function sameOwner(stat, expected) {
  return stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077)
    && (!process.getuid || stat.uid === process.getuid())
    && stat.dev === expected.device && stat.ino === expected.inode;
}
const source = fs.fstatSync(3);
if (!sameOwner(source, input.file) || source.nlink !== 1 || source.size !== input.bytes
  || input.bytes < 1 || input.bytes > input.maxBytes || !/^[a-f0-9]{64}$/.test(input.sha256)) {
  throw new Error('Bundle publication descriptor changed.');
}
const staging = '.publish-' + randomBytes(16).toString('hex');
const fd = fs.openSync(staging, fs.constants.O_WRONLY | fs.constants.O_CREAT
  | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
const owner = fs.fstatSync(fd);
try {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let bytes = 0;
  while (bytes < input.bytes) {
    const count = fs.readSync(3, buffer, 0, Math.min(buffer.length, input.bytes - bytes), bytes);
    if (!count) throw new Error('Bundle source changed during publication.');
    hash.update(buffer.subarray(0, count));
    let offset = 0;
    while (offset < count) {
      const written = fs.writeSync(fd, buffer, offset, count - offset);
      if (!written) throw new Error('Bundle publication write was incomplete.');
      offset += written;
    }
    bytes += count;
  }
  const after = fs.fstatSync(3);
  if (hash.digest('hex') !== input.sha256 || after.size !== source.size
    || after.mtimeMs !== source.mtimeMs || after.ctimeMs !== source.ctimeMs || after.nlink !== source.nlink
    || after.mode !== source.mode || after.uid !== source.uid || !sameOwner(after, input.file)) {
    throw new Error('Bundle publication failed the verified hash or source identity.');
  }
  fs.fsyncSync(fd);
  const expected = { device: owner.dev, inode: owner.ino };
  if (!sameOwner(fs.lstatSync(staging), expected)) throw new Error('Publication staging name changed.');
  try { fs.linkSync(staging, input.sha256 + '.bundle'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
} finally {
  fs.closeSync(fd);
  if (!sameOwner(fs.lstatSync(staging), { device: owner.dev, inode: owner.ino })) {
    throw new Error('Unknown publication staging entry retained.');
  }
  fs.unlinkSync(staging);
  const bankFd = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(bankFd); } finally { fs.closeSync(bankFd); }
}
`;

const BANK_OPERATION = String.raw`
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const input = JSON.parse(process.argv[1]);
const directory = fs.lstatSync('.');
if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)
  || (process.getuid && directory.uid !== process.getuid())
  || directory.dev !== input.identity.device || directory.ino !== input.identity.inode) {
  throw new Error('Private verifier ownership changed.');
}
if (input.operation === 'publish') {
  const fd = fs.openSync('source.bundle', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const result = spawnSync(input.bankInvocation.command, input.bankInvocation.args, {
      cwd: input.bankDirectory, env: process.env, stdio: ['ignore', 'pipe', 'pipe', fd],
      timeout: 120000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error('Captured-bank bundle publication failed.');
    const named = fs.lstatSync('source.bundle');
    if (!named.isFile() || named.isSymbolicLink() || named.dev !== input.file.device
      || named.ino !== input.file.inode) throw new Error('Bundle source name changed; retained for inspection.');
    fs.unlinkSync('source.bundle');
  } finally { fs.closeSync(fd); }
} else if (input.operation === 'remove') {
  for (const name of fs.readdirSync('.')) fs.rmSync(name, { recursive: true, force: false });
} else throw new Error('Private bank operation is invalid.');
`;

const REMOVE_DIRECTORY = String.raw`
const fs = require('node:fs');
const input = JSON.parse(process.argv[1]);
if (!/^\.prepare-[a-zA-Z0-9]+$/.test(input.leaf)) throw new Error('Verifier name is invalid.');
const stat = fs.lstatSync(input.leaf);
if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)
  || (process.getuid && stat.uid !== process.getuid())
  || stat.dev !== input.identity.device || stat.ino !== input.identity.inode) {
  throw new Error('Unknown verifier entry retained.');
}
fs.rmdirSync(input.leaf);
const fd = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
`;

interface BankOperationInput {
  operation: 'publish' | 'remove';
  leaf: string;
  identity: WorktreeMaterializationIdentity;
  sha256?: string;
  bytes?: number;
  file?: { device: number; inode: number };
}

async function bankOperation(bank: Awaited<ReturnType<typeof bundleDirectory>>, input: BankOperationInput) {
  await assertBank(bank);
  const preparation = path.join(bank.directory, input.leaf);
  // execve closes descriptors beyond stdio. This child validates its captured
  // bank cwd directly so the inherited regular-file descriptor remains open.
  const bankInvocation = { command: process.execPath, args: ['-e', PUBLISH_FROM_DESCRIPTOR,
    JSON.stringify({ bankIdentity: bank.identity, sha256: input.sha256, bytes: input.bytes,
      file: input.file, maxBytes: MAX_BUNDLE_BYTES })] };
  await withWorktreeMaterializationExecution(preparation, input.identity, () => materializationAwareExecFile(
    process.execPath, ['-e', BANK_OPERATION, JSON.stringify({ ...input, bankInvocation, bankDirectory: bank.directory })],
    { cwd: preparation, env: gitEnvironment(), timeout: 125_000, maxBuffer: 1024 * 1024 },
  ));
  if (input.operation === 'remove') {
    await withWorktreeMaterializationExecution(bank.directory, bank.identity, () => materializationAwareExecFile(
      process.execPath, ['-e', REMOVE_DIRECTORY, JSON.stringify(input)],
      { cwd: bank.directory, env: gitEnvironment(), timeout: 120_000, maxBuffer: 1024 * 1024 },
    ));
  }
  await assertBank(bank);
}

/** Prove all source objects in an empty repository before publishing its bank receipt. */
export async function preserveWorkspaceGitBundle(snapshot: WorkspaceSnapshotRecord, repositoryPath: string): Promise<WorkspaceGitBundleReceipt> {
  if (!snapshot.recoveryRef.startsWith('refs/o8/recovery/')) throw new Error('Portable source needs a protected recovery ref.');
  const repositoryIdentity = await captureWorktreeMaterializationIdentity(repositoryPath);
  const sourceValues = async () => {
    const ref = await gitValue(repositoryPath, repositoryIdentity, ['rev-parse', '--verify', snapshot.recoveryRef + '^{commit}']);
    const tree = await gitValue(repositoryPath, repositoryIdentity, ['rev-parse', '--verify', snapshot.recoveryRef + '^{tree}']);
    if (ref !== snapshot.headCommit || tree !== snapshot.treeSha) throw new Error('The protected Git source changed before portable preservation.');
    return {
      objectFormat: await gitValue(repositoryPath, repositoryIdentity, ['rev-parse', '--show-object-format']),
      commitCount: Number(await gitValue(repositoryPath, repositoryIdentity, ['rev-list', '--count', snapshot.recoveryRef])),
      objectCount: (await gitValue(repositoryPath, repositoryIdentity, ['rev-list', '--objects', '--no-object-names', snapshot.recoveryRef])).split('\n').length,
    };
  };
  const expected = await sourceValues();
  if (expected.objectFormat !== 'sha1' && expected.objectFormat !== 'sha256') throw new Error('Git object format is unsupported.');
  const bank = await bundleDirectory();
  const { stdout } = await withWorktreeMaterializationExecution(bank.directory, bank.identity,
    () => materializationAwareExecFile(process.execPath, ['-e', PREPARE_DIRECTORY], {
      cwd: bank.directory, env: gitEnvironment(), timeout: 120_000, maxBuffer: 1024 * 1024,
    }));
  const created = JSON.parse(stdout) as { leaf: string; device: number; inode: number };
  if (!/^\.prepare-[a-zA-Z0-9]+$/.test(created.leaf)) throw new Error('Private verifier name is invalid.');
  const preparation = path.join(bank.directory, created.leaf);
  await assertBank(bank);
  const identity = await privateDirectory(preparation);
  if (identity.device !== created.device || identity.inode !== created.inode) {
    throw new Error('Private verifier changed during ownership capture.');
  }
  const leaf = path.basename(preparation);
  try {
    await assertBank(bank);
    await createBundle(snapshot, repositoryPath, repositoryIdentity, preparation, identity);
    const before = await readBundleFile(path.join(preparation, 'source.bundle'));
    await gitValue(preparation, identity, ['init', '--bare', '--template=', '--object-format=' + expected.objectFormat, 'verify.git']);
    // Empty-repository verification refuses every prerequisite, alternate, or missing parent object.
    await gitValue(preparation, identity, ['--git-dir=verify.git', 'bundle', 'verify', 'source.bundle']);
    await gitValue(preparation, identity, ['--git-dir=verify.git', 'fetch', '--no-tags', '--no-recurse-submodules',
      './source.bundle', snapshot.recoveryRef + ':refs/heads/recovered']);
    await gitValue(preparation, identity, ['--git-dir=verify.git', 'fsck', '--full', '--strict']);
    const recovered = {
      headCommit: await gitValue(preparation, identity, ['--git-dir=verify.git', 'rev-parse', 'refs/heads/recovered^{commit}']),
      treeSha: await gitValue(preparation, identity, ['--git-dir=verify.git', 'rev-parse', 'refs/heads/recovered^{tree}']),
      commitCount: Number(await gitValue(preparation, identity, ['--git-dir=verify.git', 'rev-list', '--count', 'refs/heads/recovered'])),
      objectCount: (await gitValue(preparation, identity, ['--git-dir=verify.git', 'rev-list', '--objects', '--no-object-names', 'refs/heads/recovered'])).split('\n').length,
    };
    const after = await readBundleFile(path.join(preparation, 'source.bundle'));
    const repeated = await sourceValues();
    if (before.sha256 !== after.sha256 || !sameFile(before.stat, after.stat)
      || recovered.headCommit !== snapshot.headCommit || recovered.treeSha !== snapshot.treeSha
      || recovered.commitCount !== expected.commitCount || recovered.objectCount !== expected.objectCount
      || JSON.stringify(expected) !== JSON.stringify(repeated)) {
      throw new Error('Independent Git recovery did not prove the exact source and its required objects.');
    }
    const receipt: WorkspaceGitBundleReceipt = {
      schema: 'o8/workspace-git-bundle/v1', sha256: after.sha256, bytes: after.content.length,
      objectFormat: expected.objectFormat, repositoryUuid: snapshot.repositoryUuid, packetId: snapshot.packetId,
      snapshotGeneration: snapshot.snapshotGeneration, snapshotFingerprint: snapshot.snapshotFingerprint,
      headCommit: snapshot.headCommit, treeSha: snapshot.treeSha, recoveryRef: snapshot.recoveryRef,
      prerequisiteCount: 0, commitCount: expected.commitCount, objectCount: expected.objectCount,
    };
    await bankOperation(bank, { operation: 'publish', leaf, identity, sha256: receipt.sha256, bytes: receipt.bytes,
      file: { device: after.stat.dev, inode: after.stat.ino } });
    await readWorkspaceGitBundle(receipt);
    return receipt;
  } finally {
    await bankOperation(bank, { operation: 'remove', leaf, identity });
  }
}
