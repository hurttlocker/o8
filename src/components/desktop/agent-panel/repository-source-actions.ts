import type { RepoRegistryEntry } from '@/lib/repos/types';
import { requestJson } from '../repo-registry/shared';
import { refreshProjectsFromExternalMutation } from '../repo-registry/useProjects';
import { saveProjectGroup } from './project-group-actions';
import { remoteRepositoryIdentity } from '@/lib/repos/remote-identity';

export type RepositorySource = 'github' | 'url' | 'new';
export interface RepositoryConnectAttempt { repo?: RepoRegistryEntry }

async function verifyConnectedRepository(repo: RepoRegistryEntry, cloneUrl: string): Promise<void> {
  const candidate = await requestJson<{ repo: { localPath: string; remoteUrl: string | null; isGitRepo: boolean } }>('/api/panel/repos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'validate', localPath: repo.localPath }) }).catch(() => { throw new Error('Could not verify the saved repository folder. Retry or choose its Local folder.'); });
  if (!candidate.repo.isGitRepo || candidate.repo.localPath !== repo.localPath || remoteRepositoryIdentity(candidate.repo.remoteUrl) !== remoteRepositoryIdentity(cloneUrl)) throw new Error('The saved repository folder has changed. Choose its Local folder to reconnect it.');
}

export function repositoryUrl(value: string, source: 'github' | 'url'): string {
  const input = value.trim();
  if (!input || input.length > 2048 || input.startsWith('-')) throw new Error('Enter a repository URL.');
  const short = input.replace(/^https?:\/\/github\.com\//i, '').replace(/^github\.com\//i, '').replace(/^git@github\.com:/i, '').replace(/\.git\/?$/, '').replace(/\/$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(short) && !short.split('/').some((part) => part === '.' || part === '..')) return `https://github.com/${short}.git`;
  if (source === 'github') throw new Error('Use owner/repository or a GitHub repository URL.');
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname || !url.pathname.replace(/\//g, '')) throw new Error();
    if (url.password || url.search || url.hash || ['http:', 'https:'].includes(url.protocol) && url.username) throw new Error();
    return url.href;
  } catch { throw new Error('Use an HTTPS or SSH repository URL with your saved Git credentials.'); }
}

/** Existing clone/init APIs own disk operations; retry only a failed membership link. */
export async function connectRepository({ source, value, project, attempt }: {
  source: RepositorySource; value: string; project?: { id: string; name: string; repoPaths: string[] };
  attempt: RepositoryConnectAttempt;
}): Promise<RepoRegistryEntry> {
  try {
    if (!attempt.repo) {
      if (source === 'new') {
        const folder = value.trim();
        if (!folder.startsWith('/') && !folder.startsWith('~/') && !/^[A-Za-z]:[\\/]/.test(folder)) throw new Error('Choose an absolute folder path, such as ~/Developer/my-app.');
        attempt.repo = (await requestJson<{ repo: RepoRegistryEntry }>('/api/panel/repos/init', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: folder }) })).repo;
      } else {
        const cloneUrl = repositoryUrl(value, source);
        const inventory = await requestJson<{ repos: RepoRegistryEntry[] }>('/api/panel/repos');
        const matches = inventory.repos.filter((repo) => remoteRepositoryIdentity(repo.remoteUrl) === remoteRepositoryIdentity(cloneUrl));
        attempt.repo = matches.find((repo) => project?.repoPaths.includes(repo.localPath)) ?? matches[0];
        if (!attempt.repo) {
          try {
            attempt.repo = (await requestJson<{ repo: RepoRegistryEntry }>('/api/panel/repos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'clone', cloneUrl }) })).repo;
          } catch (cause) {
            // Registration can be durable even if its response is lost.
            const fresh = await requestJson<{ repos: RepoRegistryEntry[] }>('/api/panel/repos');
            attempt.repo = fresh.repos.find((repo) => remoteRepositoryIdentity(repo.remoteUrl) === remoteRepositoryIdentity(cloneUrl));
            if (!attempt.repo) throw cause;
          }
        }
      }
    }
    // Registry metadata can outlive a folder or an origin change. Validate
    // the actual checkout before linking it, including membership-only retries.
    if (source !== 'new') {
      try { await verifyConnectedRepository(attempt.repo, repositoryUrl(value, source)); }
      catch (cause) { attempt.repo = undefined; throw cause; }
    }
    if (project) await saveProjectGroup({ name: project.name, projectId: project.id, repoIds: [attempt.repo.id], preserveName: true });
    return attempt.repo;
  } finally { refreshProjectsFromExternalMutation(); }
}
