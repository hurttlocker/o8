import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export interface ExactDependencyFileAuthority {
  device: number;
  inode: number;
  digest: string;
}

interface ExactOpenedFile {
  handle: FileHandle;
  mode: number;
  size: number;
}

export interface HeldExactDependencyFile extends ExactDependencyFileAuthority {
  verifyUnchanged: () => Promise<void>;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function digestHandle(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < size) {
    const length = Math.min(buffer.length, size - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (offset !== size) throw new Error('Dependency image file changed during exact hashing.');
  return hash.digest('hex');
}

async function openExact(
  filePath: string,
  expected?: Pick<ExactDependencyFileAuthority, 'device' | 'inode'>,
): Promise<ExactOpenedFile> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1
      || (expected && (entry.dev !== expected.device || entry.ino !== expected.inode))) {
      throw new Error('Dependency image file does not match its exact inode authority.');
    }
    const named = await lstat(filePath);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1
      || named.dev !== entry.dev || named.ino !== entry.ino) {
      throw new Error('Dependency image file path changed during exact capture.');
    }
    return { handle, mode: entry.mode & 0o777, size: entry.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function tryOpenExact(
  filePath: string,
  expected: Pick<ExactDependencyFileAuthority, 'device' | 'inode'>,
): Promise<ExactOpenedFile | null> {
  try {
    return await openExact(filePath, expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function syncParent(filePath: string): Promise<void> {
  const parent = await open(path.dirname(filePath), constants.O_RDONLY);
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

export async function sealExactDependencyFile(
  filePath: string,
  expected?: Pick<ExactDependencyFileAuthority, 'device' | 'inode'>,
): Promise<ExactDependencyFileAuthority> {
  const captured = await openExact(filePath, expected);
  try {
    const bytes = await captured.handle.readFile();
    const beforeSeal = await captured.handle.stat();
    if (beforeSeal.size !== captured.size) {
      throw new Error('Dependency image file changed during exact sealing.');
    }
    await captured.handle.chmod(0o444);
    await captured.handle.sync();
    const sealed = await captured.handle.stat();
    const named = await lstat(filePath);
    if (sealed.dev !== named.dev || sealed.ino !== named.ino
      || sealed.size !== captured.size || (sealed.mode & 0o222) !== 0) {
      throw new Error('Dependency image file lost its exact sealed authority.');
    }
    return { device: sealed.dev, inode: sealed.ino, digest: digest(bytes) };
  } finally {
    await captured.handle.close();
  }
}

export async function writeAndSealExactDependencyFile(
  filePath: string,
  bytes: Buffer,
): Promise<ExactDependencyFileAuthority> {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const handle = await open(filePath, flags, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat();
    if (!written.isFile() || written.nlink !== 1 || written.size !== bytes.length) {
      throw new Error('Dependency image file creation lost its exact inode authority.');
    }
    await handle.chmod(0o444);
    await handle.sync();
    const sealed = await handle.stat();
    const named = await lstat(filePath);
    if (sealed.dev !== named.dev || sealed.ino !== named.ino
      || sealed.size !== bytes.length || (sealed.mode & 0o222) !== 0) {
      throw new Error('Dependency image file creation lost its exact sealed namespace.');
    }
    return { device: sealed.dev, inode: sealed.ino, digest: digest(bytes) };
  } finally {
    await handle.close();
  }
}

export async function assertExactDependencyFileIdentity(
  filePath: string,
  expected: Pick<ExactDependencyFileAuthority, 'device' | 'inode'>,
): Promise<void> {
  const captured = await openExact(filePath, expected);
  await captured.handle.close();
}

export async function readExactDependencyFile(
  filePath: string,
  expected: ExactDependencyFileAuthority,
  requireSealed = true,
): Promise<Buffer> {
  const captured = await openExact(filePath, expected);
  try {
    const bytes = await captured.handle.readFile();
    const after = await captured.handle.stat();
    if (after.size !== captured.size || digest(bytes) !== expected.digest
      || (requireSealed && (after.mode & 0o222) !== 0)) {
      throw new Error('Dependency image file content differs from its exact authority.');
    }
    return bytes;
  } finally {
    await captured.handle.close();
  }
}

export async function withHeldExactDependencyFile<T>(
  filePath: string,
  expected: ExactDependencyFileAuthority,
  operation: (held: HeldExactDependencyFile) => Promise<T>,
): Promise<T> {
  const captured = await openExact(filePath, expected);
  const verifyUnchanged = async (): Promise<void> => {
    const [current, named] = await Promise.all([captured.handle.stat(), lstat(filePath)]);
    if (!current.isFile() || current.nlink !== 1
      || current.dev !== expected.device || current.ino !== expected.inode
      || current.size !== captured.size || (current.mode & 0o222) !== 0
      || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1
      || named.dev !== expected.device || named.ino !== expected.inode
      || await digestHandle(captured.handle, captured.size) !== expected.digest) {
      throw new Error('Held dependency image file changed or lost its exact namespace.');
    }
  };
  try {
    await verifyUnchanged();
    return await operation({ ...expected, verifyUnchanged });
  } finally {
    await captured.handle.close();
  }
}

export async function exactDependencyFileAt(
  candidates: string[],
  expected: ExactDependencyFileAuthority,
): Promise<string | null> {
  for (const candidate of candidates) {
    const captured = await tryOpenExact(candidate, expected);
    if (!captured) continue;
    try {
      const bytes = await captured.handle.readFile();
      if (captured.size === bytes.length && digest(bytes) === expected.digest) return candidate;
      throw new Error('Dependency image candidate content differs from its exact authority.');
    } finally {
      await captured.handle.close();
    }
  }
  return null;
}

export async function retireGovernedDependencyFile(input: {
  canonicalPath: string;
  retiredPath: string;
  authority: ExactDependencyFileAuthority;
  phase: number;
  advancePhase: (phase: 1 | 2 | 3) => void;
  afterRename?: (retiredPath: string) => Promise<void>;
}): Promise<void> {
  if (path.dirname(input.canonicalPath) !== path.dirname(input.retiredPath)) {
    throw new Error('Dependency image retirement paths do not share one exact parent.');
  }
  let phase = input.phase;
  let canonical = await tryOpenExact(input.canonicalPath, input.authority);
  let retired = await tryOpenExact(input.retiredPath, input.authority);
  if (canonical && retired) {
    await canonical.handle.close();
    await retired.handle.close();
    throw new Error('Dependency image retirement found duplicate exact inode names.');
  }
  if (phase === 3 && (canonical || retired)) {
    await canonical?.handle.close();
    await retired?.handle.close();
    throw new Error('Released dependency image retirement still has a named inode.');
  }
  if (!canonical && !retired) {
    if (phase < 2) {
      throw new Error('Dependency image retirement lost both durable exact namespaces.');
    }
    if (phase < 3) input.advancePhase(3);
    return;
  }
  if (canonical) {
    if (phase !== 0) {
      await canonical.handle.close();
      throw new Error('Dependency image retirement phase disagrees with its canonical inode.');
    }
    let renamed = false;
    try {
      const bytes = await canonical.handle.readFile();
      if (canonical.size !== bytes.length || digest(bytes) !== input.authority.digest) {
        throw new Error('Dependency image retirement refused changed canonical content.');
      }
      await canonical.handle.chmod(0o600);
      await canonical.handle.sync();
      await rename(input.canonicalPath, input.retiredPath);
      const moved = await lstat(input.retiredPath);
      if (!moved.isFile() || moved.isSymbolicLink() || moved.nlink !== 1
        || moved.dev !== input.authority.device || moved.ino !== input.authority.inode) {
        throw new Error('Dependency image retirement renamed an unexpected inode.');
      }
      await syncParent(input.retiredPath);
      renamed = true;
      input.advancePhase(1);
      phase = 1;
      await input.afterRename?.(input.retiredPath);
    } finally {
      if (!renamed) {
        await canonical.handle.chmod(canonical.mode);
        await canonical.handle.sync();
      }
      await canonical.handle.close();
    }
    canonical = null;
    retired = await tryOpenExact(input.retiredPath, input.authority);
    if (!retired) throw new Error('Dependency image retirement lost its durable renamed inode.');
  }
  if (!retired) throw new Error('Dependency image retirement has no exact inode to finish.');
  try {
    const bytes = await retired.handle.readFile();
    if (retired.size === 0) {
      if (phase < 2) {
        input.advancePhase(2);
        phase = 2;
      }
    } else {
      if (bytes.length !== retired.size || digest(bytes) !== input.authority.digest) {
        throw new Error('Dependency image retirement refused changed retired content.');
      }
      if (phase < 1) {
        input.advancePhase(1);
        phase = 1;
      }
      await retired.handle.chmod(0o600);
      await retired.handle.sync();
      const writable = await open(input.retiredPath, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        const captured = await writable.stat();
        if (!captured.isFile() || captured.dev !== input.authority.device
          || captured.ino !== input.authority.inode) {
          throw new Error('Dependency image retirement writable handle changed inode.');
        }
        await writable.truncate(0);
        await writable.sync();
      } finally {
        await writable.close();
      }
      input.advancePhase(2);
      phase = 2;
    }
    if (phase !== 2) throw new Error('Dependency image retirement did not durably zero its inode.');
    const zeroed = await retired.handle.stat();
    const named = await lstat(input.retiredPath);
    if (zeroed.size !== 0 || named.size !== 0
      || zeroed.dev !== input.authority.device || zeroed.ino !== input.authority.inode
      || named.dev !== input.authority.device || named.ino !== input.authority.inode) {
      throw new Error('Dependency image retirement lost its exact zeroed inode.');
    }
    await unlink(input.retiredPath);
    const released = await retired.handle.stat();
    if (released.nlink !== 0) {
      throw new Error('Dependency image retirement did not release its exact namespace.');
    }
    await syncParent(input.retiredPath);
    input.advancePhase(3);
  } finally {
    await retired.handle.close();
  }
}
