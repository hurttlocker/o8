import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ActionPluginError } from './errors';
import { actionManifestSchema, reviewActionSource } from './host';
import { githubSourceSchema, sourceKey, sourceStorageRoot, type GithubActionSource } from './source-storage';
import { boundedSourceFetch, githubPackageEntries, gitBlobDigest } from './github-files';

export async function reviewGithubActionSource(input: GithubActionSource, repo?: string, callerSignal?: AbortSignal) {
  const source = githubSourceSchema.parse(input);
  if (callerSignal?.aborted) throw new ActionPluginError('cancelled', 'Source review was cancelled.', 499);
  const base = sourceStorageRoot(true);
  const destination = path.join(base, sourceKey(source));
  // Keep downloaded files, but revalidate their Git provenance and the selected
  // registered repository on every review, including reviews of a cached path.
  if (existsSync(destination)) return reviewActionSource(destination, repo, callerSignal);
  const stage = path.join(base, `.stage-${randomUUID()}`);
  mkdirSync(stage, { mode: 0o700 });
  const deadline = AbortSignal.timeout(30_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  try {
    const entry = await githubPackageEntries(source, signal);
    const download = async (name: string, limit: number) => {
      const expected = entry(name, limit);
      const location = [...(source.directory ? source.directory.split('/') : []), name].map(encodeURIComponent).join('/');
      const bytes = await boundedSourceFetch(`https://raw.githubusercontent.com/${source.repository}/${source.commit}/${location}`, limit, signal);
      if (bytes.length !== expected.size || gitBlobDigest(bytes) !== expected.sha) throw new ActionPluginError('source_changed', 'Downloaded bytes do not match the selected Git object.', 409);
      return bytes;
    };
    const manifestBytes = await download('o8-actions.json', 64 * 1024);
    const manifest = actionManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
    writeFileSync(path.join(stage, 'o8-actions.json'), manifestBytes, { flag: 'wx', mode: 0o600 });
    for (const file of manifest.files) {
      const bytes = await download(file.path, 1024 * 1024);
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new ActionPluginError('digest_mismatch', 'Downloaded action does not match its declared digest.', 409);
      writeFileSync(path.join(stage, file.path), bytes, { flag: 'wx', mode: 0o700 });
    }
    writeFileSync(path.join(stage, '.origin.json'), JSON.stringify({ source, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex') }), { flag: 'wx', mode: 0o600 });
    try { renameSync(stage, destination); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    return await reviewActionSource(destination, repo, signal);
  } catch (error) {
    if (error instanceof ActionPluginError || error instanceof z.ZodError) throw error;
    if (callerSignal?.aborted) throw new ActionPluginError('cancelled', 'Source review was cancelled.', 499);
    if (deadline.aborted) throw new ActionPluginError('source_timeout', 'Source acquisition timed out. No plugin was installed.', 504);
    throw new ActionPluginError('source_unavailable', 'Could not acquire this public source. No plugin was installed.', 502);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
