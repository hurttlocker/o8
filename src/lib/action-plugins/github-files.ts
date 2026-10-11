import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ActionPluginError } from './errors';
import type { GithubActionSource } from './source-storage';

const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
const treeSchema = z.object({ sha: gitSha, truncated: z.boolean(), tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: gitSha, size: z.number().int().nonnegative().optional() })).max(5000) });

export function gitBlobDigest(bytes: Buffer) { return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); }

export async function boundedSourceFetch(url: string, limit: number, signal: AbortSignal) {
  const response = await fetch(url, { redirect: 'error', credentials: 'omit', cache: 'no-store', signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'o8-action-source-review' } });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ActionPluginError('source_unavailable', 'Public source or exact commit is unavailable. Check the repository and commit.', response.status === 404 ? 404 : 502);
  }
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > limit) { await response.body?.cancel(); throw new ActionPluginError('source_too_large', 'The selected source exceeds the download limit.'); }
  if (!response.body) throw new ActionPluginError('source_unavailable', 'The source response was empty.', 502);
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let count = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      count += value.byteLength;
      if (count > limit) throw new ActionPluginError('source_too_large', 'The selected source exceeds the download limit.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, count);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function githubPackageEntries(source: GithubActionSource, signal: AbortSignal) {
  const api = `https://api.github.com/repos/${source.repository}`;
  const json = async (url: string) => JSON.parse((await boundedSourceFetch(url, 2 * 1024 * 1024, signal)).toString('utf8')) as unknown;
  const commit = z.object({ sha: gitSha, tree: z.object({ sha: gitSha }) }).parse(await json(`${api}/git/commits/${source.commit}`));
  if (commit.sha !== source.commit) throw new ActionPluginError('source_changed', 'The returned commit does not match the selected source.', 409);
  const tree = async (sha: string) => {
    const result = treeSchema.parse(await json(`${api}/git/trees/${sha}`));
    if (result.sha !== sha || result.truncated) throw new ActionPluginError('invalid_source', 'The source tree is incomplete or changed.');
    return result.tree;
  };
  let entries = await tree(commit.tree.sha);
  for (const part of source.directory ? source.directory.split('/') : []) {
    const entry = entries.find((item) => item.path === part);
    if (!entry || entry.type !== 'tree' || entry.mode !== '040000') throw new ActionPluginError('invalid_source', 'The package directory is missing or linked.');
    entries = await tree(entry.sha);
  }
  return (name: string, limit: number) => {
    const found = entries.find((item) => item.path === name);
    if (!found || found.type !== 'blob' || !['100644', '100755'].includes(found.mode) || found.size === undefined || found.size > limit) throw new ActionPluginError('invalid_source', 'A declared source file is missing, linked, or oversized.');
    return found;
  };
}

export async function verifyGithubFiles(source: GithubActionSource, files: Array<{ path: string; data: Buffer }>, callerSignal?: AbortSignal) {
  const deadline = AbortSignal.timeout(30_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  try {
    const entry = await githubPackageEntries(source, signal);
    for (const file of files) {
      const expected = entry(file.path, file.path === 'o8-actions.json' ? 64 * 1024 : 1024 * 1024);
      if (file.data.length !== expected.size || gitBlobDigest(file.data) !== expected.sha) throw new ActionPluginError('source_changed', 'Cached bytes do not match the selected Git object.', 409);
    }
  } catch (error) {
    if (error instanceof ActionPluginError || error instanceof z.ZodError) throw error;
    if (callerSignal?.aborted) throw new ActionPluginError('cancelled', 'Source review was cancelled.', 499);
    if (deadline.aborted) throw new ActionPluginError('source_timeout', 'Source verification timed out. No plugin was installed.', 504);
    throw new ActionPluginError('source_unavailable', 'Could not verify this exact public source. No plugin was installed.', 502);
  }
}
