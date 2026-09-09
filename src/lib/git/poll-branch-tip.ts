import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Missing is distinct from unreadable: only proven absence permits a local-ref fallback. */
async function readMetadata(file: string, limit = 4096): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Unsupported ref metadata');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('Ref metadata exceeds bound');
    return buffer.toString('utf8', 0, bytesRead).trim();
  } finally {
    await handle.close();
  }
}

/**
 * Read a known files-backed branch tip without starting Git. This is only an
 * unchanged-cursor shortcut, never the source for ingestion. Ambiguous layouts,
 * symbolic refs, read errors and environment overrides return null so callers
 * use Git. No negative cache can hide a newly initialized repo or fetched ref.
 */
export async function readPollBranchTip(repoPath: string, branch: string): Promise<string | null> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch)
    || branch.includes('..')
    || branch.endsWith('.')
    || branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))
    || Object.keys(process.env).some((key) => /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|NAMESPACE|CONFIG)/.test(key))) {
    return null;
  }
  try {
    let gitDir = join(repoPath, '.git');
    const marker = await lstat(gitDir);
    if (marker.isFile()) {
      const pointer = await readMetadata(gitDir);
      if (!pointer?.startsWith('gitdir: ')) return null;
      gitDir = resolve(dirname(gitDir), pointer.slice(8));
    } else if (!marker.isDirectory()) {
      return null;
    }
    const common = await readMetadata(join(gitDir, 'commondir'));
    if (common === '') return null;
    const commonDir = common === null ? gitDir : resolve(gitDir, common);
    const config = await readMetadata(join(commonDir, 'config'), 64 * 1024);
    if (!config || /refstorage\s*=/i.test(config)) return null;

    let packed: string | null | undefined;
    const readRef = async (ref: string): Promise<string | null> => {
      const loose = await readMetadata(join(commonDir, ref));
      if (loose !== null) {
        if (!OBJECT_ID.test(loose)) throw new Error('Unsupported loose ref');
        return loose;
      }
      packed ??= await readMetadata(join(commonDir, 'packed-refs'), 1024 * 1024);
      let match: string | null = null;
      for (const line of (packed ?? '').split('\n')) {
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('^') && OBJECT_ID.test(line.slice(1))) continue;
        const separator = line.indexOf(' ');
        if (separator < 0 || !OBJECT_ID.test(line.slice(0, separator))) {
          throw new Error('Unsupported packed ref');
        }
        if (line.endsWith(` ${ref}`)) {
          match = line.slice(0, separator);
        }
      }
      return match;
    };
    return await readRef(`refs/remotes/origin/${branch}`) ?? await readRef(`refs/heads/${branch}`);
  } catch {
    return null;
  }
}
