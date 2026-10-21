import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { probeMetadataLockProcessIdentity, type MetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';

export interface BankWriteReceipt {
  phase: 'ready' | 'prepared' | 'complete';
  pid: number;
  processIdentity: MetadataLockProcessIdentity;
  device?: number;
  inode?: number;
  bytes?: number;
  sha256?: string;
  compressedBytes?: number;
  compressedSha256?: string;
}

const CAPTURE_FILE = String.raw`
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createGzip } = require('node:zlib');
const input = JSON.parse(process.argv[1]);
function signal() {
  const bytes = []; const byte = Buffer.alloc(1);
  while (true) {
    if (!fs.readSync(0, byte, 0, 1, null)) return null;
    if (byte[0] === 10) return Buffer.from(bytes).toString('utf8');
    if (bytes.length > 32) throw new Error('Bank acknowledgement exceeded its bound.');
    bytes.push(byte[0]);
  }
}
function parent() {
  const stat = fs.lstatSync('.');
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== input.parent.device
    || stat.ino !== input.parent.inode || fs.realpathSync('.') !== input.parent.canonicalPath) {
    throw new Error('Bank destination parent changed.');
  }
}
function sourceMatches(stat) {
  return stat.isFile() && stat.nlink === 1 && stat.dev === input.source.device
    && stat.ino === input.source.inode && stat.size === input.source.bytes
    && stat.mtimeMs === input.source.mtimeMs && stat.ctimeMs === input.source.ctimeMs;
}
async function main() {
  parent();
  if (!(input.manifest ? input.name === 'manifest.json' : /^(0|[1-9][0-9]*)\.gz$/.test(input.name))) {
    throw new Error('Bank capture has an unsafe destination leaf.');
  }
  if (!input.manifest && !sourceMatches(fs.fstatSync(3))) throw new Error('Bank source descriptor changed.');
  process.stdout.write(JSON.stringify({ phase: 'ready' }) + '\n');
  if (signal() !== 'create') throw new Error('Bank child ownership was not persisted.');
  parent();
  const fd = fs.openSync(input.name, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
    | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const owner = fs.fstatSync(fd);
    const parentFd = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
    process.stdout.write(JSON.stringify({ phase: 'prepared', device: owner.dev, inode: owner.ino }) + '\n');
    if (signal() !== 'continue') throw new Error('Bank file ownership was not persisted.');
    parent();
    const rawHash = crypto.createHash('sha256'); const compressedHash = crypto.createHash('sha256');
    let bytes = 0; let compressedBytes = 0;
    const raw = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > input.bytes) return callback(new Error('Bank source byte bound exceeded.'));
      rawHash.update(chunk); callback(null, chunk);
    } });
    const compressed = new Transform({ transform(chunk, _encoding, callback) {
      compressedBytes += chunk.length;
      if (compressedBytes > input.compressedLimit) return callback(new Error('Bank compressed byte bound exceeded.'));
      const capacity = fs.statfsSync('.');
      if (Number(capacity.bavail) * Number(capacity.bsize) < 256 * 1024 ** 2 + chunk.length) {
        return callback(new Error('Bank maintenance capacity is held.'));
      }
      compressedHash.update(chunk); callback(null, chunk);
    } });
    const reader = input.manifest ? process.stdin : fs.createReadStream(null, { fd: 3, autoClose: false, start: 0 });
    const stages = input.manifest ? [reader, raw, compressed] : [reader, raw, createGzip({ level: 1 }), compressed];
    await pipeline(...stages, fs.createWriteStream(null, { fd, autoClose: false }));
    const sha256 = rawHash.digest('hex'); const compressedSha256 = compressedHash.digest('hex');
    if (bytes !== input.bytes || (input.manifest && sha256 !== input.sha256)
      || (!input.manifest && !sourceMatches(fs.fstatSync(3)))) throw new Error('Bank source changed during capture.');
    fs.fsyncSync(fd);
    const actual = fs.fstatSync(fd); const named = fs.lstatSync(input.name);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || actual.size !== compressedBytes
      || actual.dev !== owner.dev || actual.ino !== owner.ino || named.dev !== owner.dev || named.ino !== owner.ino
      || (actual.mode & 0o777) !== 0o600) throw new Error('Bank destination changed during capture.');
    parent();
    process.stdout.write(JSON.stringify({ phase: 'complete', device: owner.dev, inode: owner.ino,
      bytes, sha256, compressedBytes, compressedSha256 }) + '\n');
  } finally { fs.closeSync(fd); }
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 78; });
`;

/** Writes stay in the captured native cwd; every inode is persisted before bytes. */
export async function captureBankFile(input: {
  parent: WorktreeMaterializationIdentity;
  name: string;
  bytes: number;
  compressedLimit: number;
  source?: { fd: number; device: number; inode: number; bytes: number; mtimeMs: number; ctimeMs: number };
  manifest?: Buffer;
  receipt: (value: BankWriteReceipt) => Promise<void>;
}): Promise<BankWriteReceipt> {
  // The script verifies its OS-captured cwd before creation and writing. An
  // intervening Node execve guard closes fd3 and loses the source descriptor.
  const args = ['-e', CAPTURE_FILE, JSON.stringify({
    parent: input.parent, name: input.name, bytes: input.bytes, compressedLimit: input.compressedLimit,
    source: input.source, manifest: Boolean(input.manifest),
    sha256: input.manifest ? createHash('sha256').update(input.manifest).digest('hex') : undefined,
  })];
  const child = spawn(process.execPath, args, { cwd: input.parent.canonicalPath,
    stdio: ['pipe', 'pipe', 'pipe', ...(input.source ? [input.source.fd] : [])] });
  let output = ''; let stderr = ''; let failure: unknown;
  let phase: BankWriteReceipt['phase'] | null = null;
  let identity: MetadataLockProcessIdentity | null = null;
  let complete: BankWriteReceipt | null = null;
  let prepared: { device: number; inode: number } | null = null;
  let receipts = Promise.resolve();
  const closed = new Promise<number | null>(resolve => {
    child.once('error', error => { failure = error; });
    child.once('close', resolve);
  });
  const timeout = setTimeout(() => {
    failure = new Error('Bank file capture exceeded its bounded deadline.');
    child.stdin!.destroy();
    child.kill('SIGTERM');
  }, 120_000);
  child.stdin!.on('error', error => { if (!failure) failure = error; });
  child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 4096); });
  child.stdout!.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > 4096) { failure = new Error('Bank child receipt bound exceeded.'); child.stdin!.destroy(); return; }
    let newline;
    while ((newline = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, newline); output = output.slice(newline + 1);
      receipts = receipts.then(async () => {
        const value = JSON.parse(line) as Omit<BankWriteReceipt, 'pid' | 'processIdentity'>;
        const expected = phase === null ? 'ready' : phase === 'ready' ? 'prepared' : 'complete';
        if (value.phase !== expected || phase === 'complete' || !child.pid) throw new Error('Bank child receipt sequence is invalid.');
        if (value.phase === 'ready') {
          const probe = await probeMetadataLockProcessIdentity(child.pid);
          if (probe.state !== 'live') throw new Error('Bank capture child has unknown process identity.');
          identity = probe.identity;
        } else if (!Number.isSafeInteger(value.device) || !Number.isSafeInteger(value.inode)) {
          throw new Error('Bank capture returned an invalid inode.');
        }
        if (value.phase === 'prepared') prepared = { device: value.device!, inode: value.inode! };
        if (value.phase === 'complete' && (!prepared || value.device !== prepared.device || value.inode !== prepared.inode
          || value.bytes !== input.bytes || !Number.isSafeInteger(value.compressedBytes)
          || value.compressedBytes! < 0 || value.compressedBytes! > input.compressedLimit
          || !/^[0-9a-f]{64}$/.test(value.sha256 ?? '') || !/^[0-9a-f]{64}$/.test(value.compressedSha256 ?? ''))) {
          throw new Error('Bank capture completion is invalid.');
        }
        const receipt = { ...value, pid: child.pid, processIdentity: identity! };
        await input.receipt(receipt);
        phase = value.phase;
        if (value.phase === 'ready') child.stdin!.write('create\n');
        if (value.phase === 'prepared') child.stdin!.end(input.manifest
          ? Buffer.concat([Buffer.from('continue\n'), input.manifest]) : 'continue\n');
        if (value.phase === 'complete') complete = receipt;
      }).catch(error => { failure = error; child.stdin!.end(); });
    }
  });
  try {
    const code = await closed;
    await receipts;
    if (failure) throw failure;
    if (code !== 0 || !complete || phase !== 'complete') throw new Error(stderr || 'Bank capture child did not complete.');
    return complete;
  } finally {
    clearTimeout(timeout);
    child.stdin!.end();
  }
}
