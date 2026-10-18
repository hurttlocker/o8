import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

/** Native workers may read owner policy, never its neighboring state or secrets. */
export async function ownerInstructionPaths(
  canonicalHome: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string[]> {
  // Inject the environment so resolving a data root cannot start a migration.
  const roots = new Set([path.join(canonicalHome, '.o8'), path.resolve(getDataDir({ ...env }, canonicalHome))]);
  const candidates = [
    path.join(canonicalHome, 'AGENTS.md'), path.join(canonicalHome, 'CLAUDE.md'),
    ...[...roots].map(root => path.join(root, 'OPERATING_AGREEMENT.md')),
  ];
  const files: string[] = [];
  for (const file of candidates) {
    const entry = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!entry) continue;
    // Refuse aliases, including intermediate symlinks and hardlinks. Do not
    // follow an instruction name into an arbitrary credential or private file.
    if (!entry.isFile() || entry.nlink !== 1 || await realpath(file) !== file) {
      throw new Error('Owner instructions must be regular, non-aliased files.');
    }
    files.push(file);
  }
  return files;
}
