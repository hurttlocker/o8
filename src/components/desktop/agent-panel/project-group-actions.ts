import type { ProjectWithRepos } from '@/lib/projects/types';
import { broadcastProjectsUpdated } from '../repo-registry/useProjects';

async function request<T>(url: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method, cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || 'Could not save this project. Try again.');
  return data;
}

/** Membership changes use existing APIs. Removing a link never unregisters a repository. */
export interface ProjectCreateAttempt { knownIds?: Set<string>; uncertain?: boolean }

export async function saveProjectGroup({ name, repoIds, projectId, attempt = {}, preserveName = false }: { name: string; repoIds: string[]; projectId?: string; attempt?: ProjectCreateAttempt; preserveName?: boolean }): Promise<ProjectWithRepos> {
  try {
    if (!projectId) {
      attempt.knownIds ??= new Set((await request<{ projects: ProjectWithRepos[] }>('/api/projects', 'GET')).projects.map((project) => project.id));
      const recover = async () => {
        const { projects } = await request<{ projects: ProjectWithRepos[] }>('/api/projects', 'GET');
        const candidates = projects.filter((project) => !attempt.knownIds!.has(project.id) && project.name === name.trim() && project.repos.length === repoIds.length && project.repos.every((link) => repoIds.includes(link.repoId)));
        if (candidates.length !== 1) throw new Error('Could not confirm the saved project. Check All projects before creating it again.');
        return candidates[0];
      };
      // A dropped response can follow a durable create. Reconcile this attempt
      // before any retry, rather than issuing a second non-idempotent POST.
      if (attempt.uncertain) return await recover();
      attempt.uncertain = true;
      try {
        const { project } = await request<{ project: ProjectWithRepos }>('/api/projects', 'POST', { name: name.trim(), repoIds, mainRepoId: repoIds[0] ?? null });
        return project;
      } catch { return await recover(); }
    }
    // Read current membership on save so an old open drawer cannot erase newly added repos.
    const { project } = await request<{ project: ProjectWithRepos }>(`/api/projects/${encodeURIComponent(projectId)}`, 'GET');
    if (!preserveName && project.name !== name.trim()) await request(`/api/projects/${encodeURIComponent(projectId)}`, 'PATCH', { name: name.trim() });
    const existing = new Set(project.repos.map((link) => link.repoId));
    for (const repoId of repoIds) {
      if (!existing.has(repoId)) await request(`/api/projects/${encodeURIComponent(projectId)}/repos`, 'POST', { repoId });
    }
    return (await request<{ project: ProjectWithRepos }>(`/api/projects/${encodeURIComponent(projectId)}`, 'GET')).project;
  } finally {
    // A partial or lost response can still follow a durable change.
    broadcastProjectsUpdated();
  }
}

export async function removeProjectRepo(projectId: string, repoId: string): Promise<void> {
  try { await request(`/api/projects/${encodeURIComponent(projectId)}/repos/${encodeURIComponent(repoId)}`, 'DELETE'); }
  finally { broadcastProjectsUpdated(); }
}
