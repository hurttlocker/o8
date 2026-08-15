import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { retireExactChildFile } from './exact-parent-operation';

/** Retire, zero, and release one exact file through a captured parent cwd. */
export async function retireExactFile(
  candidatePath: string,
  expected: { device: number; inode: number },
): Promise<string> {
  const before = await lstat(candidatePath);
  if (!before.isFile() || before.isSymbolicLink()
    || before.dev !== expected.device || before.ino !== expected.inode) {
    throw new Error('Exact file retirement identity changed before claim.');
  }
  const retiredPath = path.join(
    path.dirname(candidatePath),
    `.o8-retired-${path.basename(candidatePath)}-${randomUUID()}`,
  );
  const parentPath = path.dirname(candidatePath);
  const parent = await lstat(parentPath);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error('Exact file retirement parent is not a regular directory.');
  }
  await retireExactChildFile(
    parentPath,
    { device: parent.dev, inode: parent.ino, canonicalPath: await realpath(parentPath) },
    candidatePath,
    retiredPath,
    expected,
  );
  return retiredPath;
}
