import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

import { materializationAwareExecFile, withWorktreeMaterializationExecution } from '@/lib/worktree/materialization-execution';
import { assertWorktreeMaterializationIdentity, captureWorktreeMaterializationIdentity,
  type WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';

type FileReceipt = { device: number; inode: number; sha256: string };
/** Generated-output custody only. This is never containing-workspace manager authority. */
export interface LinkedGitBuildCustody {
  schema: 'o8/linked-git-build-custody/v1';
  common: WorktreeMaterializationIdentity;
  registrations: WorktreeMaterializationIdentity;
  admin: WorktreeMaterializationIdentity;
  gitFile: FileReceipt;
  backPointer: FileReceipt;
  commonFile: FileReceipt;
}

export function validateLinkedGitBuildCustody(value: LinkedGitBuildCustody): void {
  const directory = (entry: WorktreeMaterializationIdentity) => entry && path.isAbsolute(entry.canonicalPath)
    && path.resolve(entry.canonicalPath) === entry.canonicalPath && Number.isSafeInteger(entry.device)
    && Number.isSafeInteger(entry.inode) && entry.inode > 0;
  if (!value || value.schema !== 'o8/linked-git-build-custody/v1'
    || ![value.common, value.registrations, value.admin].every(directory)
    || value.registrations.canonicalPath !== path.join(value.common.canonicalPath, 'worktrees')
    || path.dirname(value.admin.canonicalPath) !== value.registrations.canonicalPath
    || ![value.gitFile, value.backPointer, value.commonFile].every(file => file
      && Number.isSafeInteger(file.device) && Number.isSafeInteger(file.inode) && file.inode > 0
      && /^[a-f0-9]{64}$/.test(file.sha256))) {
    throw new Error('Linked Git build custody receipt is invalid.');
  }
}

async function directory(name: string): Promise<WorktreeMaterializationIdentity> {
  const identity = await captureWorktreeMaterializationIdentity(name);
  if (identity.canonicalPath !== name) throw new Error('Linked Git administration is redirected.');
  const stat = await lstat(name);
  if (process.getuid && stat.uid !== process.getuid()) throw new Error('Linked Git administration has foreign ownership.');
  return identity;
}

async function pointer(parent: WorktreeMaterializationIdentity, name: string) {
  await assertWorktreeMaterializationIdentity(parent.canonicalPath, parent);
  const target = path.join(parent.canonicalPath, name);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 4096
      || (process.getuid && before.uid !== process.getuid())) throw new Error('Linked Git pointer is unsafe.');
    const bytes = Buffer.alloc(4097);
    const read = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    const named = await lstat(target);
    if (read.bytesRead !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || named.dev !== before.dev || named.ino !== before.ino || named.size !== before.size
      || named.mtimeMs !== before.mtimeMs || named.ctimeMs !== before.ctimeMs) {
      throw new Error('Linked Git pointer changed during capture.');
    }
    await assertWorktreeMaterializationIdentity(parent.canonicalPath, parent);
    const content = bytes.subarray(0, read.bytesRead);
    const text = content.toString('utf8').replace(/\n$/, '');
    if (!text || /[\r\n\0]/.test(text)) throw new Error('Linked Git pointer is malformed.');
    return { text, receipt: { device: before.dev, inode: before.ino,
      sha256: createHash('sha256').update(content).digest('hex') } };
  } finally { await file.close(); }
}

/** Require reciprocal registration, not merely a .git file that Git can follow. */
export async function captureLinkedGitBuildCustody(workspace: WorktreeMaterializationIdentity): Promise<LinkedGitBuildCustody | undefined> {
  await assertWorktreeMaterializationIdentity(workspace.canonicalPath, workspace);
  const gitPath = path.join(workspace.canonicalPath, '.git');
  const git = await lstat(gitPath);
  if (git.isDirectory() && !git.isSymbolicLink()) return undefined;
  const gitFile = await pointer(workspace, '.git');
  if (!gitFile.text.startsWith('gitdir: ')) throw new Error('Linked Git pointer lacks a gitdir.');
  const admin = await directory(path.resolve(workspace.canonicalPath, gitFile.text.slice(8)));
  const commonFile = await pointer(admin, 'commondir');
  const common = await directory(path.resolve(admin.canonicalPath, commonFile.text));
  const registrations = await directory(path.join(common.canonicalPath, 'worktrees'));
  if (path.dirname(admin.canonicalPath) !== registrations.canonicalPath) throw new Error('Linked Git admin is outside its common registration directory.');
  const backPointer = await pointer(admin, 'gitdir');
  if (!path.isAbsolute(backPointer.text) || backPointer.text !== gitPath) throw new Error('Linked Git registration does not point back to this checkout.');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  await withWorktreeMaterializationExecution(workspace.canonicalPath, workspace, async () => {
    const options = { cwd: workspace.canonicalPath, env, timeout: 10_000, maxBuffer: 1024 ** 2 };
    const resolved = (await materializationAwareExecFile('git', ['rev-parse', '--path-format=absolute',
      '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], options)).stdout.trim().split('\n');
    if (JSON.stringify(resolved) !== JSON.stringify([workspace.canonicalPath, admin.canonicalPath, common.canonicalPath])) {
      throw new Error('Linked Git resolved paths disagree with registration.');
    }
    const listing = (await materializationAwareExecFile('git', [`--git-dir=${common.canonicalPath}`,
      'worktree', 'list', '--porcelain', '-z'], options)).stdout.split('\0');
    if (listing.filter(line => line === `worktree ${workspace.canonicalPath}`).length !== 1) {
      throw new Error('Linked Git checkout is not uniquely registered.');
    }
  });
  for (const identity of [workspace, common, registrations, admin]) {
    await assertWorktreeMaterializationIdentity(identity.canonicalPath, identity);
  }
  for (const [parent, name, observed] of [[workspace, '.git', gitFile], [admin, 'gitdir', backPointer],
    [admin, 'commondir', commonFile]] as const) {
    if (JSON.stringify(await pointer(parent, name)) !== JSON.stringify(observed)) throw new Error('Linked Git registration changed.');
  }
  const receipt: LinkedGitBuildCustody = { schema: 'o8/linked-git-build-custody/v1', common, registrations, admin,
    gitFile: gitFile.receipt, backPointer: backPointer.receipt, commonFile: commonFile.receipt };
  validateLinkedGitBuildCustody(receipt);
  return receipt;
}

export async function assertLinkedGitBuildCustody(workspace: WorktreeMaterializationIdentity,
  expected: LinkedGitBuildCustody | undefined): Promise<void> {
  if (JSON.stringify(await captureLinkedGitBuildCustody(workspace)) !== JSON.stringify(expected)) {
    throw new Error('Linked Git build custody changed from its persisted receipt.');
  }
}
