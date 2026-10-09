import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, statfs } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { getDataDir } from '@/lib/data-dir-migration';
import { getSqlite } from '@/lib/db';
import { guardedWorkspaceInvocation } from '@/lib/worktree/materialization-execution';
import { probeMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { assertWorktreeMaterializationIdentity, captureWorktreeMaterializationIdentity,
  type WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { createExactChildDirectory } from './exact-parent-operation';
import { verifyGeneratedOutputBank, verifyGeneratedOutputEntries, type GeneratedOutputBankEntry,
  type GeneratedOutputContentEntry } from './generated-output-bank';
import { recordRecoveryEntry, type RecoveryWritePhase, type RecoveryWriteReceipt } from './generated-output-recovery-journal';
import { readGeneratedOutputResource, saveGeneratedOutputResource, withGeneratedOutputBankExclusion,
  type GeneratedOutputResource } from './generated-output-state';

const execFileAsync = promisify(execFile);

async function restoreDirectoryMode(identity: WorktreeMaterializationIdentity, mode: number): Promise<void> {
  const invocation = guardedWorkspaceInvocation(process.execPath, ['-e', String.raw`
    const fs = require('node:fs');
    const fd = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fchmodSync(fd, Number(process.argv[1])); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  `, String(mode)], identity);
  await execFileAsync(invocation.command, invocation.args, { cwd: identity.canonicalPath, timeout: 10_000 });
}

/** Fresh full recovery readback follows persisted identities, never a completion flag alone. */
export function readGeneratedOutputRecoveryEntries(resource: GeneratedOutputResource): GeneratedOutputContentEntry[] {
  const recovery = resource.recovery;
  if (!resource.bank || !recovery?.root || recovery.state !== 'complete'
    || recovery.bankDigest !== resource.bank.digest) throw new Error('Generated-output recovery is incomplete.');
  const rows = getSqlite().prepare(`SELECT relative, kind, device, inode, phase, observed_closed, exit_code, receipt_json
    FROM workspace_generated_output_recovery_entries WHERE resource_id = ? AND operation_id = ? LIMIT 20001`)
    .all(resource.resourceId, recovery.operationId) as Array<{ relative: string; kind: string;
      device: number; inode: number; phase: string; observed_closed: number; exit_code: number;
      receipt_json: string | null }>;
  if (rows.length !== resource.bank.entries.length) throw new Error('Recovery journal entry count changed.');
  const recorded = new Map(rows.map(row => [row.relative, row]));
  return resource.bank.entries.map(entry => {
    const row = recorded.get(entry.relative);
    if (!row || row.phase !== 'complete' || row.observed_closed !== 1 || row.exit_code !== 0
      || (entry.kind === 'file' && (!row.receipt_json || !JSON.parse(row.receipt_json).processIdentity))
      || row.kind !== entry.kind || !Number.isSafeInteger(row.device) || !Number.isSafeInteger(row.inode) || row.inode <= 0) {
      throw new Error('Generated-output recovery journal or identity changed.');
    }
    if (entry.kind === 'file') {
      const native = JSON.parse(row.receipt_json!) as RecoveryWriteReceipt;
      if (!Number.isSafeInteger(native.pid) || native.pid <= 0 || native.device !== row.device || native.inode !== row.inode) {
        throw new Error('Recovery native close receipt lost its inode binding.');
      }
    }
    return { relative: entry.relative, kind: entry.kind, mode: entry.mode, bytes: entry.bytes,
      sha256: entry.sha256, device: row.device, inode: row.inode };
  });
}

/** Fresh full recovery readback follows persisted identities, never a completion flag alone. */
export async function verifyGeneratedOutputRecovery(resource: GeneratedOutputResource,
  candidatePath = resource.recovery?.path,
  releaseIntents?: Array<{ relative: string; device: number; inode: number }>): Promise<void> {
  if (!candidatePath || !resource.recovery?.root) throw new Error('Recovery has no exact candidate namespace.');
  await verifyGeneratedOutputEntries({ entries: readGeneratedOutputRecoveryEntries(resource),
    candidate: { ...resource.recovery.root, canonicalPath: candidatePath }, releaseIntents });
}

// The child pins its actual parent cwd and the inherited compressed descriptor.
// It creates exclusively and waits for a durable inode receipt before any write.
const RESTORE_FILE = String.raw`
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createGunzip } = require('node:zlib');
const input = JSON.parse(process.argv[1]);
function readSignal() {
  const chunks = []; const byte = Buffer.alloc(1);
  while (true) {
    if (!fs.readSync(0, byte, 0, 1, null)) return null;
    if (byte[0] === 10) return Buffer.from(chunks).toString('utf8');
    if (chunks.length > 64) throw new Error('Recovery acknowledgement exceeded its bound.');
    chunks.push(byte[0]);
  }
}
function verifyParent() {
  const stat = fs.lstatSync('.');
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== input.parent.device
    || stat.ino !== input.parent.inode || fs.realpathSync('.') !== input.parent.canonicalPath) {
    throw new Error('Recovery destination parent changed.');
  }
}
async function main() {
  verifyParent();
  if (!input.name || input.name === '.' || input.name === '..'
    || input.name.includes('/') || input.name.includes('\\')) throw new Error('Unsafe recovery leaf.');
  const compressedStat = fs.fstatSync(3);
  if (!compressedStat.isFile() || compressedStat.nlink !== 1 || compressedStat.size !== input.entry.compressedBytes) {
    throw new Error('Recovery compressed descriptor is unsafe.');
  }
  process.stdout.write(JSON.stringify({ phase: 'ready' }) + '\n');
  if (readSignal() !== 'continue') throw new Error('Recovery process ownership was not persisted.');
  verifyParent();
  const fd = fs.openSync(input.name, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
    | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const owner = fs.fstatSync(fd);
    const parentFd = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
    process.stdout.write(JSON.stringify({ phase: 'prepared', device: owner.dev, inode: owner.ino }) + '\n');
    if (readSignal() !== 'continue') throw new Error('Recovery ownership was not persisted.');
    verifyParent();
    const content = crypto.createHash('sha256'); const compressed = crypto.createHash('sha256');
    let bytes = 0; let compressedBytes = 0;
    await pipeline(fs.createReadStream(null, { fd: 3, autoClose: false, start: 0 }), new Transform({
      transform(chunk, _encoding, callback) {
        compressedBytes += chunk.length;
        if (compressedBytes > input.entry.compressedBytes) return callback(new Error('Compressed recovery byte bound exceeded.'));
        compressed.update(chunk); callback(null, chunk);
      },
    }), createGunzip(), new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > input.entry.bytes) return callback(new Error('Expanded recovery byte bound exceeded.'));
        const capacity = fs.statfsSync('.');
        if (Number(capacity.bavail) * Number(capacity.bsize) < 256 * 1024 ** 2) {
          return callback(new Error('Recovery maintenance capacity floor reached.'));
        }
        content.update(chunk); callback(null, chunk);
      },
    }), fs.createWriteStream(null, { fd, autoClose: false }));
    if (bytes !== input.entry.bytes || compressedBytes !== input.entry.compressedBytes
      || content.digest('hex') !== input.entry.sha256 || compressed.digest('hex') !== input.entry.compressedSha256) {
      throw new Error('Recovery streamed content differs from the verified bank.');
    }
    fs.fchmodSync(fd, input.entry.mode); fs.fsyncSync(fd);
    const check = crypto.createHash('sha256'); const chunk = Buffer.alloc(65536); let offset = 0;
    while (offset < bytes) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, bytes - offset), offset);
      if (!count) throw new Error('Recovery readback ended early.');
      check.update(chunk.subarray(0, count)); offset += count;
    }
    const actual = fs.fstatSync(fd); const named = fs.lstatSync(input.name);
    if (check.digest('hex') !== input.entry.sha256 || actual.size !== bytes || actual.nlink !== 1
      || actual.dev !== owner.dev || actual.ino !== owner.ino || named.dev !== owner.dev || named.ino !== owner.ino
      || !named.isFile() || named.isSymbolicLink() || (actual.mode & 0o777) !== input.entry.mode) {
      throw new Error('Recovery destination changed during readback.');
    }
    verifyParent();
    process.stdout.write(JSON.stringify({ phase: 'written', device: owner.dev, inode: owner.ino }) + '\n');
    if (readSignal() !== 'continue') throw new Error('Recovery completion was not persisted.');
  } finally { fs.closeSync(fd); }
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 78; });
`;

async function restoreFile(input: {
  parent: WorktreeMaterializationIdentity;
  name: string;
  bankFile: string;
  entry: GeneratedOutputBankEntry;
  receipt: (phase: Exclude<RecoveryWritePhase, 'planned'>, value: RecoveryWriteReceipt) => Promise<void>;
}): Promise<void> {
  const reader = await open(input.bankFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<number | null> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const before = await reader.stat();
    const named = await lstat(input.bankFile);
    if (!before.isFile() || before.nlink !== 1 || before.size !== input.entry.compressedBytes
      || before.dev !== input.entry.bankDevice || before.ino !== input.entry.bankInode
      || named.dev !== before.dev || named.ino !== before.ino) throw new Error('Recovery bank file changed.');
    // RESTORE_FILE pins and verifies its actual cwd before any creation/write;
    // direct spawn also preserves the inherited compressed descriptor at fd3.
    child = spawn(process.execPath,
      ['-e', RESTORE_FILE, JSON.stringify({ parent: input.parent, name: input.name, entry: input.entry })], {
      cwd: input.parent.canonicalPath,
      stdio: ['pipe', 'pipe', 'pipe', reader.fd] });
    let output = ''; let errorText = ''; let failure: unknown;
    let receipts = Promise.resolve(); let phase: RecoveryWritePhase | null = null;
    let receipt: RecoveryWriteReceipt | undefined;
    closed = new Promise<number | null>(resolve => {
      child!.once('error', error => { failure = error; });
      child!.once('close', resolve);
    });
    timer = setTimeout(() => { failure = new Error('Recovery writer exceeded its 120s bound.'); child!.kill('SIGTERM'); }, 120_000);
    child.stderr!.on('data', (chunk: Buffer) => { errorText = (errorText + chunk.toString()).slice(0, 4096); });
    child.stdin!.on('error', error => { failure = error; });
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 4096) { failure = new Error('Recovery receipt bound exceeded.'); child!.stdin!.destroy(); return; }
      let newline;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        receipts = receipts.then(async () => {
          const value = JSON.parse(line) as { device?: number; inode?: number; phase: 'ready' | 'prepared' | 'written' };
          if (value.phase !== (phase === null ? 'ready' : phase === 'ready' ? 'prepared' : phase === 'prepared' ? 'written' : null)) {
            throw new Error('Recovery returned an invalid ownership sequence.');
          }
          if (value.phase === 'ready') {
            if (!child!.pid) throw new Error('Recovery child has no native PID.');
            const owner = await probeMetadataLockProcessIdentity(child!.pid);
            if (owner.state !== 'live') throw new Error('Recovery child birth is unknown.');
            receipt = { pid: child!.pid, processIdentity: owner.identity };
          } else {
            if (!Number.isSafeInteger(value.device) || !Number.isSafeInteger(value.inode)
              || value.inode! <= 0 || (receipt!.device !== undefined
                && (receipt!.device !== value.device || receipt!.inode !== value.inode))) {
              throw new Error('Recovery inode receipt changed.');
            }
            receipt = { ...receipt!, device: value.device, inode: value.inode };
            const named = await lstat(path.join(input.parent.canonicalPath, input.name));
            if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1
              || named.dev !== value.device || named.ino !== value.inode
              || named.size !== (value.phase === 'prepared' ? 0 : input.entry.bytes)) {
              throw new Error('Recovery native named inode changed before acknowledgement.');
            }
          }
          await input.receipt(value.phase, receipt!); phase = value.phase; child!.stdin!.write('continue\n');
        }).catch(error => { failure = error; child!.stdin!.end(); });
      }
    });
    const code = await closed; await receipts;
    if (failure) throw failure;
    if (code !== 0 || phase !== 'written') throw new Error(errorText || 'Recovery child did not complete.');
    const after = await reader.stat(); const current = await lstat(input.bankFile);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.dev !== before.dev || current.ino !== before.ino) throw new Error('Recovery bank descriptor changed.');
    await input.receipt('complete', receipt!);
  } finally {
    child?.stdin?.end();
    if (closed) await closed;
    if (timer) clearTimeout(timer);
    await reader.close();
  }
}

/** Recover into a new private registered destination; failures remain held, never overwritten. */
export async function recoverGeneratedOutput(resourceId: string,
  purpose: 'recovery' | 'verification-disposable' = 'recovery'): Promise<GeneratedOutputResource> {
  const selected = readGeneratedOutputResource(resourceId);
  if (!selected?.bank || !selected.owner) throw new Error('Generated output has no verified recovery bank.');
  return withGeneratedOutputBankExclusion(selected, async () => {
    let resource = readGeneratedOutputResource(resourceId)!;
    if (resource.recovery?.state === 'complete') {
      if (resource.recovery.purpose !== purpose) throw new Error('Existing recovery creation purpose cannot be changed.');
      await verifyGeneratedOutputBank(resource.bank!);
      await verifyGeneratedOutputRecovery(resource);
      return resource;
    }
    if (!resource.bank || (resource.recovery && resource.recovery.state !== 'retired')) {
      throw new Error('Generated-output recovery is already registered or unavailable.');
    }
    await verifyGeneratedOutputBank(resource.bank);
    const base = path.join(getDataDir(), 'recovered-generated-output');
    if (base === resource.workspace.canonicalPath || base.startsWith(resource.workspace.canonicalPath + path.sep)) {
      throw new Error('Generated-output recovery must survive containing-workspace retirement.');
    }
    const data = await captureWorktreeMaterializationIdentity(getDataDir());
    if (base !== path.join(data.canonicalPath, 'recovered-generated-output')) throw new Error('Recovery base is redirected.');
    if (!await lstat(base).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    })) await createExactChildDirectory(data.canonicalPath, data, base, 0o700);
    const parent = await captureWorktreeMaterializationIdentity(base);
    const capacity = await statfs(base);
    if (Number(capacity.bavail) * Number(capacity.bsize) < resource.bank.expandedBytes + 256 * 1024 ** 2) {
      throw new Error('Insufficient bounded generated-output recovery capacity.');
    }
    const operationId = randomUUID(); const destination = path.join(parent.canonicalPath, operationId);
    const owner = await probeMetadataLockProcessIdentity(process.pid);
    if (owner.state !== 'live') throw new Error('Recovery operation birth is unknown.');
    resource = saveGeneratedOutputResource(resource, { recovery: { operationId, purpose, createdAt: Date.now(), path: destination, parent,
      ownerPid: process.pid, ownerIdentity: owner.identity,
      root: null, state: 'planned', bankDigest: resource.bank.digest } });
    try {
      recordRecoveryEntry(resource, '.', 'directory', 'planned');
      const created = await createExactChildDirectory(parent.canonicalPath, parent, destination, 0o700);
      const root = await captureWorktreeMaterializationIdentity(destination);
      if (root.device !== created.device || root.inode !== created.inode) throw new Error('Recovery root changed after creation.');
      const directories = new Map<string, WorktreeMaterializationIdentity>([['.', root]]);
      resource = saveGeneratedOutputResource(resource, { recovery: { ...resource.recovery!, root, state: 'restoring' } });
      recordRecoveryEntry(resource, '.', 'directory', 'complete', root);
      const bank = resource.bank!;
      for (const entry of bank.entries.filter(row => row.kind === 'directory' && row.relative !== '.')
        .sort((a, b) => a.relative.split('/').length - b.relative.split('/').length)) {
        const relativeParent = path.posix.dirname(entry.relative); const containing = directories.get(relativeParent);
        if (!containing) throw new Error('Recovery directory ancestry is missing.');
        const directoryPath = path.join(destination, entry.relative);
        recordRecoveryEntry(resource, entry.relative, 'directory', 'planned');
        const receipt = await createExactChildDirectory(containing.canonicalPath, containing, directoryPath, 0o700);
        const identity = await captureWorktreeMaterializationIdentity(directoryPath);
        if (identity.device !== receipt.device || identity.inode !== receipt.inode) throw new Error('Recovery directory changed.');
        directories.set(entry.relative, identity);
        recordRecoveryEntry(resource, entry.relative, 'directory', 'complete', identity);
      }
      for (const entry of bank.entries.filter(row => row.kind === 'file')) {
        const containing = directories.get(path.posix.dirname(entry.relative));
        if (!containing) throw new Error('Recovery file ancestry is missing.');
        recordRecoveryEntry(resource, entry.relative, 'file', 'planned');
        await restoreFile({ parent: containing, name: path.posix.basename(entry.relative),
          bankFile: path.join(bank.root.canonicalPath, 'files', entry.compressedName!), entry,
          receipt: async (phase, value) => {
            recordRecoveryEntry(resource, entry.relative, 'file', phase, value.device === undefined ? undefined : value, value);
          } });
      }
      for (const identity of directories.values()) await assertWorktreeMaterializationIdentity(identity.canonicalPath, identity);
      for (const entry of bank.entries.filter(row => row.kind === 'directory')
        .sort((a, b) => b.relative.split('/').length - a.relative.split('/').length)) {
        await restoreDirectoryMode(directories.get(entry.relative)!, entry.mode);
      }
      await verifyGeneratedOutputBank(bank);
      const completed = { ...resource, recovery: { ...resource.recovery!, state: 'complete' as const, completedAt: Date.now() } };
      await verifyGeneratedOutputRecovery(completed);
      resource = saveGeneratedOutputResource(resource, { recovery: completed.recovery });
      return resource;
    } catch (error) {
      saveGeneratedOutputResource(resource, { recovery: { ...resource.recovery!, state: 'failed-held' } });
      throw error;
    }
  });
}
