import { execFile } from 'node:child_process';
import { readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TrackedGitEntry {
  mode: string;
  objectId: string;
  path: string;
}

function pathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function trackedGitEntries(
  workspacePath: string,
  relativeTarget: string,
): Promise<TrackedGitEntry[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--stage', '-z', '--', relativeTarget],
    {
      cwd: workspacePath,
      encoding: 'buffer',
      timeout: 15_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    },
  );
  return stdout.toString('utf8').split('\0').filter(Boolean).map((record) => {
    const separator = record.indexOf('\t');
    const metadata = separator >= 0 ? record.slice(0, separator).split(' ') : [];
    const entryPath = separator >= 0 ? record.slice(separator + 1) : '';
    const [mode, objectId, stage] = metadata;
    if (!mode || !/^[0-9a-f]{40,64}$/.test(objectId ?? '') || stage !== '0'
      || (entryPath !== relativeTarget && !entryPath.startsWith(`${relativeTarget}/`))) {
      throw new Error(`Local dependency has an invalid tracked Git identity: ${relativeTarget}`);
    }
    return { mode, objectId: objectId!, path: entryPath };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export async function assertContainedTrackedSymlinks(
  workspacePath: string,
  entries: TrackedGitEntry[],
): Promise<void> {
  const canonicalRoot = await realpath(workspacePath);
  for (const entry of entries) {
    if (entry.mode !== '120000') continue;
    const linkPath = path.join(workspacePath, entry.path);
    const target = await readlink(linkPath);
    const resolvedTarget = path.resolve(path.dirname(linkPath), target);
    if (!pathInside(resolvedTarget, workspacePath)) {
      throw new Error(`Local dependency symlink escapes its workspace: ${entry.path}`);
    }
    const canonicalTarget = await realpath(resolvedTarget).catch(() => null);
    if (!canonicalTarget || !pathInside(canonicalTarget, canonicalRoot)) {
      throw new Error(`Local dependency symlink has no contained target: ${entry.path}`);
    }
  }
}
