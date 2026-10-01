import 'server-only';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Remote checkouts must start from an advertised, fetchable revision. */
export async function resolvePublishedCloudBase(repoPath: string, baseRef: string): Promise<string> {
  const options = { cwd: repoPath, timeout: 60_000, maxBuffer: 64 * 1024 };
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', '--exit-code', 'origin', baseRef], options);
    const refs = stdout.trim().split('\n');
    if (refs.length !== 1) throw new Error('Remote ref is ambiguous.');
    const sha = refs[0].split(/\s+/)[0];
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('Invalid advertised revision.');
    // Do not use FETCH_HEAD: another task's fetch can overwrite it between calls.
    await execFileAsync('git', ['fetch', '--quiet', '--no-write-fetch-head', 'origin', sha], options);
    return sha;
  } catch {
    throw new Error('Remote base is unavailable from origin. Publish the requested revision or choose a published branch, then retry.');
  }
}
