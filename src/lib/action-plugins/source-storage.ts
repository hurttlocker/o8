import 'server-only';
import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getDataDir } from '@/lib/data-dir-migration';
import { ActionPluginError } from './errors';

export const githubSourceSchema = z.object({
  kind: z.literal('github'),
  repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  directory: z.string().max(240).refine((value) => value === '' || (value.split('/').length <= 8 && value.split('/').every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(part) && part !== '.' && part !== '..')), 'Use a relative package directory without traversal (up to eight levels).'),
}).strict();
export type GithubActionSource = z.infer<typeof githubSourceSchema>;

export function sourceKey(source: GithubActionSource) {
  return createHash('sha256').update(JSON.stringify(githubSourceSchema.parse(source))).digest('hex');
}

export function sourceStorageRoot(create: boolean) {
  let at = getDataDir();
  for (const part of ['', 'customizations', 'action-sources']) {
    if (part) at = path.join(at, part);
    if (create && !existsSync(at)) {
      try { mkdirSync(at, { recursive: !part, mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const stat = lstatSync(at);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ActionPluginError('unsafe_path', 'Invalid action source storage directory.');
  }
  return at;
}

export function acquiredSource(directory: string, manifestBytes: Buffer): GithubActionSource | undefined {
  const relative = path.relative(path.join(getDataDir(), 'customizations', 'action-sources'), directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  if (!/^[a-f0-9]{64}$/.test(relative)) throw new ActionPluginError('unsafe_source', 'Invalid acquired source location.');
  sourceStorageRoot(false);
  const file = path.join(directory, '.origin.json');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw new ActionPluginError('unsafe_source', 'Invalid acquired source metadata.');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try { bytes = readFileSync(fd); } finally { closeSync(fd); }
  if (bytes.length > 4096) throw new ActionPluginError('unsafe_source', 'Invalid acquired source metadata.');
  const record = z.object({ source: githubSourceSchema, manifestSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(JSON.parse(bytes.toString('utf8')));
  if (sourceKey(record.source) !== relative || createHash('sha256').update(manifestBytes).digest('hex') !== record.manifestSha256) {
    throw new ActionPluginError('source_changed', 'Acquired source metadata or manifest changed. Acquire and review a new source.', 409);
  }
  return record.source;
}
