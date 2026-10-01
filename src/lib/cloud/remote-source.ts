import 'server-only';

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import { resolvePublishedCloudBase } from './published-base';
import type { LaunchOptions } from '@/lib/runtimes/types';

const GIT_OPTIONS = { encoding: 'utf8' as const, timeout: 5_000, maxBuffer: 64 * 1024 };

function git(repo: string, ...args: string[]) {
  try { return execFileSync('git', ['-C', repo, ...args], GIT_OPTIONS).trim(); }
  catch { throw new Error('Remote launch source could not be verified from the registered repository.'); }
}

function validRemoteUrl(value: string) {
  if (!value || /[\s\0-\x1f]/.test(value)) return false;
  if (/^git@[a-z0-9.-]+:[a-zA-Z0-9._/-]+$/i.test(value)) return true;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'ssh:')
      && !!url.hostname && url.pathname.length > 1 && !url.password
      && (url.protocol === 'ssh:' ? (!url.username || url.username === 'git') : !url.username)
      && !url.search && !url.hash;
  } catch { return false; }
}

function validRef(value: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value)
    && !value.includes('..') && !value.includes('//') && !value.endsWith('/')
    && !value.endsWith('.') && !value.endsWith('.lock');
}

/** Resolve remote execution identity before any durable job is enqueued. */
export async function resolveCloudRemoteSource(opts: LaunchOptions) {
  if (!opts.packetId || !opts.sourceRepoPath || !opts.branchName) {
    throw new Error('Remote execution requires a packet, registered repository, and assigned branch.');
  }
  if (opts.workMode === 'read-only') throw new Error('This remote worker cannot enforce read-only packet execution.');
  if (!validRef(opts.branchName)) throw new Error('The assigned remote branch is invalid.');
  const baseRef = opts.baseBranch?.trim() || 'HEAD';
  if (baseRef !== 'HEAD' && !validRef(baseRef)) throw new Error('The remote base ref is invalid.');
  let canonicalSource: string;
  try { canonicalSource = realpathSync.native(opts.sourceRepoPath); }
  catch { throw new Error('The registered remote source directory is unavailable.'); }
  const repo = await findRepoByLocalPath(canonicalSource);
  if (!repo?.isGitRepo || !repo.remoteUrl || !validRemoteUrl(repo.remoteUrl)) {
    throw new Error('Remote execution requires a registered Git repository with a credential-free HTTPS or SSH origin.');
  }
  const origin = git(repo.localPath, 'remote', 'get-url', 'origin');
  if (origin !== repo.remoteUrl) throw new Error('The registered remote changed. Refresh the repository before dispatch.');
  git(repo.localPath, 'check-ref-format', '--branch', opts.branchName);
  const baseSha = await resolvePublishedCloudBase(repo.localPath, baseRef);
  if (!/^[a-f0-9]{40,64}$/.test(baseSha)) throw new Error('The remote base revision is invalid.');
  return { repoUrl: repo.remoteUrl, baseSha, branch: opts.branchName };
}
