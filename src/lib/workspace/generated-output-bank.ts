import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import { assertWorktreeMaterializationIdentity, captureWorktreeMaterializationIdentity,
  type WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { createExactChildDirectory } from './exact-parent-operation';
import { captureBankFile, type BankWriteReceipt } from './generated-output-bank-io';

export const GENERATED_BANK_LIMITS = { entries: 20_000, expandedBytes: 5 * 1024 ** 3,
  compressedBytes: 2 * 1024 ** 3, manifestBytes: 8 * 1024 ** 2 } as const;

export interface GeneratedOutputBankEntry {
  relative: string;
  kind: 'file' | 'directory';
  device: number;
  inode: number;
  mode: number;
  bytes: number;
  mtimeMs: number;
  ctimeMs: number;
  sha256: string | null;
  compressedName: string | null;
  compressedBytes: number;
  compressedSha256: string | null;
  bankDevice: number | null;
  bankInode: number | null;
}

export interface GeneratedOutputBank {
  schema: 'o8/generated-output-bank/v1';
  root: WorktreeMaterializationIdentity;
  files: WorktreeMaterializationIdentity;
  source: WorktreeMaterializationIdentity;
  entries: GeneratedOutputBankEntry[];
  expandedBytes: number;
  compressedBytes: number;
  digest: string;
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function relativeName(value: string): void {
  if (value === '.') return;
  if (!value || value.length > 4096 || value.includes('\\') || value.includes('\0')
    || path.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Generated-output bank has an unsafe relative path.');
  }
}

async function names(directory: string): Promise<string[]> {
  const result: string[] = [];
  for await (const entry of await opendir(directory)) {
    if (result.length >= GENERATED_BANK_LIMITS.entries) throw new Error('Generated-output entry bound exceeded.');
    result.push(entry.name);
  }
  return result.sort();
}

async function inventory(identity: WorktreeMaterializationIdentity): Promise<GeneratedOutputBankEntry[]> {
  await assertWorktreeMaterializationIdentity(identity.canonicalPath, identity);
  const entries: GeneratedOutputBankEntry[] = [];
  const pending = ['.'];
  let bytes = 0;
  while (pending.length) {
    const relative = pending.pop()!;
    relativeName(relative);
    if (entries.length >= GENERATED_BANK_LIMITS.entries) throw new Error('Generated-output entry bound exceeded.');
    const candidate = path.join(identity.canonicalPath, relative);
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())
      || (stat.isFile() && stat.nlink !== 1) || await realpath(candidate) !== candidate) {
      throw new Error('Generated-output bank refuses links, redirected paths, and special nodes.');
    }
    const kind = stat.isDirectory() ? 'directory' : 'file';
    bytes += kind === 'file' ? stat.size : 0;
    if (bytes > GENERATED_BANK_LIMITS.expandedBytes) throw new Error('Generated-output expanded byte bound exceeded.');
    entries.push({ relative, kind, device: stat.dev, inode: stat.ino, mode: stat.mode & 0o777,
      bytes: kind === 'file' ? stat.size : 0, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
      sha256: null, compressedName: null, compressedBytes: 0, compressedSha256: null,
      bankDevice: null, bankInode: null });
    if (kind === 'directory') {
      for (const name of (await names(candidate)).reverse()) {
        pending.push(relative === '.' ? name : `${relative}/${name}`);
        if (pending.length + entries.length > GENERATED_BANK_LIMITS.entries) {
          throw new Error('Generated-output entry bound exceeded.');
        }
      }
    }
  }
  await assertWorktreeMaterializationIdentity(identity.canonicalPath, identity);
  return entries.sort((a, b) => a.relative.localeCompare(b.relative));
}

function sameEntry(expected: GeneratedOutputBankEntry, observed: Awaited<ReturnType<typeof lstat>>): boolean {
  return observed.isFile() && !observed.isSymbolicLink() && observed.nlink === 1
    && observed.dev === expected.device && observed.ino === expected.inode && observed.size === expected.bytes
    && observed.mtimeMs === expected.mtimeMs && observed.ctimeMs === expected.ctimeMs;
}

/** Capture is non-destructive; an incomplete bank remains registered and held. */
export async function captureGeneratedOutputBank(input: {
  source: WorktreeMaterializationIdentity;
  bankPath: string;
  parent: WorktreeMaterializationIdentity;
  register: (identity: WorktreeMaterializationIdentity, files?: WorktreeMaterializationIdentity) => Promise<void>;
  receipt: (index: number, entry: GeneratedOutputBankEntry | null,
    phase: 'planned' | 'ready' | 'prepared' | 'written' | 'complete', value?: BankWriteReceipt) => Promise<void>;
}): Promise<GeneratedOutputBank> {
  const bankPath = path.resolve(input.bankPath);
  if (bankPath === input.source.canonicalPath || bankPath.startsWith(input.source.canonicalPath + path.sep)) {
    throw new Error('Generated-output bank must be outside its source.');
  }
  if (path.dirname(bankPath) !== input.parent.canonicalPath) throw new Error('Bank creation has no exact containing parent.');
  const created = await createExactChildDirectory(input.parent.canonicalPath, input.parent, bankPath, 0o700);
  const root = await captureWorktreeMaterializationIdentity(bankPath);
  if (root.device !== created.device || root.inode !== created.inode) throw new Error('Bank root changed after exclusive creation.');
  await input.register(root);
  const filesPath = path.join(bankPath, 'files');
  const createdFiles = await createExactChildDirectory(bankPath, root, filesPath, 0o700);
  const files = await captureWorktreeMaterializationIdentity(filesPath);
  if (files.device !== createdFiles.device || files.inode !== createdFiles.inode) throw new Error('Bank files directory changed after creation.');
  await input.register(root, files);
  const entries = await inventory(input.source);
  let compressedBytes = 0;
  let expandedBytes = 0;
  for (const [index, entry] of entries.entries()) {
    if (entry.kind !== 'file') continue;
    await assertWorktreeMaterializationIdentity(bankPath, root);
    await assertWorktreeMaterializationIdentity(filesPath, files);
    await assertWorktreeMaterializationIdentity(input.source.canonicalPath, input.source);
    const sourcePath = path.join(input.source.canonicalPath, entry.relative);
    const reader = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const compressedName = `${index}.gz`;
    try {
      if (!sameEntry(entry, await reader.stat())) throw new Error('Generated-output source changed before banking.');
      await input.receipt(index, entry, 'planned');
      const result = await captureBankFile({ parent: files, name: compressedName,
        bytes: entry.bytes, compressedLimit: GENERATED_BANK_LIMITS.compressedBytes - compressedBytes,
        source: { fd: reader.fd, ...entry },
        receipt: value => input.receipt(index, entry, value.phase === 'complete' ? 'written' : value.phase, value) });
      if (!sameEntry(entry, await reader.stat())
        || !sameEntry(entry, await lstat(sourcePath))) throw new Error('Generated-output source changed during banking.');
      await input.receipt(index, entry, 'complete', result);
      Object.assign(entry, { sha256: result.sha256, compressedName,
        compressedBytes: result.compressedBytes, compressedSha256: result.compressedSha256,
        bankDevice: result.device, bankInode: result.inode });
      expandedBytes += result.bytes!; compressedBytes += result.compressedBytes!;
    } finally { await reader.close(); }
  }
  const after = await inventory(input.source);
  const structural = (rows: GeneratedOutputBankEntry[]) => rows.map(({ sha256: _s, compressedName: _n,
    compressedBytes: _b, compressedSha256: _c, bankDevice: _d, bankInode: _i, ...row }) => row);
  if (JSON.stringify(structural(after)) !== JSON.stringify(structural(entries))) {
    throw new Error('Generated-output namespace changed across capture.');
  }
  const bank: GeneratedOutputBank = { schema: 'o8/generated-output-bank/v1', root, files, source: input.source,
    entries, expandedBytes, compressedBytes, digest: hash(JSON.stringify(entries)) };
  const manifest = JSON.stringify(bank);
  if (Buffer.byteLength(manifest) > GENERATED_BANK_LIMITS.manifestBytes) throw new Error('Generated-output manifest bound exceeded.');
  await input.receipt(-1, null, 'planned');
  const manifestResult = await captureBankFile({ parent: root, name: 'manifest.json',
    bytes: Buffer.byteLength(manifest), compressedLimit: GENERATED_BANK_LIMITS.manifestBytes,
    manifest: Buffer.from(manifest),
    receipt: value => input.receipt(-1, null, value.phase === 'complete' ? 'written' : value.phase, value) });
  await input.receipt(-1, null, 'complete', manifestResult);
  await verifyGeneratedOutputBank(bank);
  return bank;
}

/** Fresh readback checks the entire bank, never just its saved receipt. */
export async function verifyGeneratedOutputBank(bank: GeneratedOutputBank): Promise<void> {
  validateGeneratedOutputBank(bank);
  await assertWorktreeMaterializationIdentity(bank.root.canonicalPath, bank.root);
  await assertWorktreeMaterializationIdentity(bank.files.canonicalPath, bank.files);
  for (const identity of [bank.root, bank.files]) {
    if (((await lstat(identity.canonicalPath)).mode & 0o777) !== 0o700) {
      throw new Error('Generated-output bank directories lost their private modes.');
    }
  }
  if (JSON.stringify(await names(bank.root.canonicalPath)) !== JSON.stringify(['files', 'manifest.json'])) {
    throw new Error('Generated-output bank has an unrecorded root namespace.');
  }
  const manifestPath = path.join(bank.root.canonicalPath, 'manifest.json');
  const manifest = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await manifest.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
      || stat.size > GENERATED_BANK_LIMITS.manifestBytes) {
      throw new Error('Generated-output bank manifest is unsafe.');
    }
    const observed = await manifest.readFile('utf8');
    const named = await lstat(manifestPath);
    const after = await manifest.stat();
    if (observed !== JSON.stringify(bank) || named.dev !== stat.dev || named.ino !== stat.ino
      || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
      || named.size !== stat.size || named.mtimeMs !== stat.mtimeMs || named.ctimeMs !== stat.ctimeMs) {
      throw new Error('Generated-output bank manifest changed.');
    }
  } finally { await manifest.close(); }
  const files = bank.files.canonicalPath;
  if ((await lstat(files)).isSymbolicLink() || await realpath(files) !== files
    || JSON.stringify(await names(files)) !== JSON.stringify(bank.entries.filter(e => e.kind === 'file')
      .map(e => e.compressedName).sort())) throw new Error('Generated-output bank inventory changed.');
  let expandedBytes = 0;
  let compressedBytes = 0;
  const seen = new Set<string>();
  for (const entry of bank.entries) {
    relativeName(entry.relative);
    if (seen.has(entry.relative)) throw new Error('Generated-output bank has duplicate paths.');
    seen.add(entry.relative);
    if (entry.kind !== 'file') continue;
    if (!entry.compressedName || !/^\d+\.gz$/.test(entry.compressedName) || !entry.sha256) {
      throw new Error('Generated-output compressed file authority is invalid.');
    }
    const candidate = path.join(files, entry.compressedName);
    const reader = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await reader.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.compressedBytes
        || stat.dev !== entry.bankDevice || stat.ino !== entry.bankInode || (stat.mode & 0o777) !== 0o600) {
        throw new Error('Generated-output compressed file is unsafe.');
      }
      const content = createHash('sha256');
      const compressed = createHash('sha256');
      let bytes = 0; let readCompressed = 0;
      await pipeline(reader.createReadStream({ autoClose: false }), new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          readCompressed += chunk.length;
          if (readCompressed > entry.compressedBytes) {
            callback(new Error('Generated-output compressed file bound exceeded.')); return;
          }
          compressed.update(chunk); callback(null, chunk);
        },
      }), createGunzip(), new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > entry.bytes) { callback(new Error('Generated-output expanded file bound exceeded.')); return; }
          content.update(chunk); callback();
        },
      }));
      const after = await reader.stat();
      const named = await lstat(candidate);
      if (bytes !== entry.bytes || readCompressed !== entry.compressedBytes || content.digest('hex') !== entry.sha256
        || compressed.digest('hex') !== entry.compressedSha256 || after.dev !== stat.dev || after.ino !== stat.ino
        || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
        || named.dev !== stat.dev || named.ino !== stat.ino || named.size !== stat.size
        || named.mtimeMs !== stat.mtimeMs || named.ctimeMs !== stat.ctimeMs) {
        throw new Error('Generated-output bank file content or identity changed.');
      }
      expandedBytes += bytes; compressedBytes += stat.size;
    } finally { await reader.close(); }
  }
  if (expandedBytes !== bank.expandedBytes || compressedBytes !== bank.compressedBytes) {
    throw new Error('Generated-output bank byte accounting changed.');
  }
  await assertWorktreeMaterializationIdentity(bank.root.canonicalPath, bank.root);
  await assertWorktreeMaterializationIdentity(bank.files.canonicalPath, bank.files);
}

/** Reject malformed geometry and impossible accounting before opening bank files. */
export function validateGeneratedOutputBank(bank: GeneratedOutputBank): void {
  const integer = (value: unknown, minimum = 0) => Number.isSafeInteger(value) && Number(value) >= minimum;
  const identity = (value: WorktreeMaterializationIdentity | undefined) => value
    && integer(value.device) && integer(value.inode, 1) && typeof value.canonicalPath === 'string'
    && path.isAbsolute(value.canonicalPath) && path.resolve(value.canonicalPath) === value.canonicalPath
    && value.canonicalPath !== path.parse(value.canonicalPath).root;
  if (!bank || bank.schema !== 'o8/generated-output-bank/v1' || !identity(bank.root) || !identity(bank.files)
    || !identity(bank.source) || bank.files.canonicalPath !== path.join(bank.root.canonicalPath, 'files')
    || bank.files.device !== bank.root.device || bank.files.inode === bank.root.inode
    || bank.root.canonicalPath === bank.source.canonicalPath
    || bank.root.canonicalPath.startsWith(bank.source.canonicalPath + path.sep)
    || !Array.isArray(bank.entries) || bank.entries.length < 1 || bank.entries.length > GENERATED_BANK_LIMITS.entries
    || !integer(bank.expandedBytes) || bank.expandedBytes > GENERATED_BANK_LIMITS.expandedBytes
    || !integer(bank.compressedBytes) || bank.compressedBytes > GENERATED_BANK_LIMITS.compressedBytes
    || !/^[0-9a-f]{64}$/.test(bank.digest) || hash(JSON.stringify(bank.entries)) !== bank.digest) {
    throw new Error('Generated-output bank authority is invalid.');
  }
  const seen = new Map<string, GeneratedOutputBankEntry>();
  let expanded = 0; let compressed = 0;
  for (const [index, entry] of bank.entries.entries()) {
    if (!entry || typeof entry.relative !== 'string') throw new Error('Generated-output entry geometry is invalid.');
    relativeName(entry.relative);
    if (entry.relative.split('/').length > 128 || seen.has(entry.relative)
      || !['directory', 'file'].includes(entry.kind) || !integer(entry.device) || !integer(entry.inode, 1)
      || entry.device !== bank.source.device || !integer(entry.mode) || entry.mode > 0o777
      || !integer(entry.bytes) || !integer(entry.compressedBytes)
      || !Number.isFinite(entry.mtimeMs) || !Number.isFinite(entry.ctimeMs)
      || entry.mtimeMs < 0 || entry.ctimeMs < 0) throw new Error('Generated-output entry authority is invalid.');
    if (entry.kind === 'directory') {
      if (entry.bytes !== 0 || entry.compressedBytes !== 0 || entry.sha256 !== null
        || entry.compressedName !== null || entry.compressedSha256 !== null
        || entry.bankDevice !== null || entry.bankInode !== null) throw new Error('Generated-output directory accounting is invalid.');
    } else {
      if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? '') || !/^[0-9a-f]{64}$/.test(entry.compressedSha256 ?? '')
        || entry.compressedName !== `${index}.gz` || !integer(entry.compressedBytes, 1)
        || entry.bankDevice !== bank.files.device || !integer(entry.bankInode, 1)) {
        throw new Error('Generated-output compressed entry authority is invalid.');
      }
      expanded += entry.bytes; compressed += entry.compressedBytes;
      if (!Number.isSafeInteger(expanded) || expanded > GENERATED_BANK_LIMITS.expandedBytes
        || !Number.isSafeInteger(compressed) || compressed > GENERATED_BANK_LIMITS.compressedBytes) {
        throw new Error('Generated-output bank accounting exceeds its bounds.');
      }
    }
    seen.set(entry.relative, entry);
  }
  const root = seen.get('.');
  if (root?.kind !== 'directory' || root.device !== bank.source.device || root.inode !== bank.source.inode
    || expanded !== bank.expandedBytes || compressed !== bank.compressedBytes) {
    throw new Error('Generated-output bank source root or byte accounting changed.');
  }
  for (const entry of bank.entries) {
    if (entry.relative !== '.' && seen.get(path.posix.dirname(entry.relative))?.kind !== 'directory') {
      throw new Error('Generated-output bank ancestry is incomplete.');
    }
  }
}

/** Fresh bytes must match the bank. Only this journal's recorded release intent permits zero bytes. */
export async function verifyGeneratedOutputContents(input: {
  bank: GeneratedOutputBank;
  candidate: WorktreeMaterializationIdentity;
  releaseIntents?: Array<{ relative: string; device: number; inode: number }>;
}): Promise<void> {
  return verifyGeneratedOutputEntries({ ...input, entries: input.bank.entries });
}

export type GeneratedOutputContentEntry = Pick<GeneratedOutputBankEntry,
  'relative' | 'device' | 'inode' | 'kind' | 'mode' | 'bytes' | 'sha256'>;

/** Same raw content checks apply to native restored inodes, without inventing a bank. */
export async function verifyGeneratedOutputEntries(input: {
  entries: GeneratedOutputContentEntry[];
  candidate: WorktreeMaterializationIdentity;
  releaseIntents?: Array<{ relative: string; device: number; inode: number }>;
}): Promise<void> {
  const expected = new Map(input.entries.map(entry => [entry.relative, entry]));
  const observed = await inventory(input.candidate);
  if (!input.releaseIntents && observed.length !== expected.size) throw new Error('Generated-output namespace changed after banking.');
  const intents = new Map(input.releaseIntents?.map(entry => [entry.relative, entry]));
  for (const actual of observed) {
    const prior = expected.get(actual.relative);
    if (!prior || actual.device !== prior.device || actual.inode !== prior.inode || actual.kind !== prior.kind
      || (actual.mode !== prior.mode && (!input.releaseIntents || actual.mode !== (prior.mode | 0o200)))) {
      throw new Error('Generated-output namespace or identity changed after banking.');
    }
    if (actual.kind !== 'file') continue;
    const intent = intents.get(actual.relative);
    if (actual.bytes === 0 && intent?.device === actual.device && intent.inode === actual.inode) continue;
    if (actual.bytes !== prior.bytes) throw new Error('Generated-output file length changed after banking.');
    const candidate = path.join(input.candidate.canonicalPath, actual.relative);
    const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!sameEntry(actual, await file.stat())) throw new Error('Generated-output file changed before verification.');
      const digest = createHash('sha256');
      let count = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        count += chunk.length;
        if (count > prior.bytes) throw new Error('Generated-output file grew during verification.');
        digest.update(chunk);
      }
      if (count !== prior.bytes || digest.digest('hex') !== prior.sha256
        || !sameEntry(actual, await file.stat()) || !sameEntry(actual, await lstat(candidate))) {
        throw new Error('Generated-output file bytes changed after banking.');
      }
    } finally { await file.close(); }
  }
  await assertWorktreeMaterializationIdentity(input.candidate.canonicalPath, input.candidate);
}
