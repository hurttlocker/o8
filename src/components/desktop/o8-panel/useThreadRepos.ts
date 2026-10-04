import { useEffect, useState } from 'react';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import type { RepoRegistryEntry } from '@/lib/repos/types';

/** A focused session can belong to a different project than the global rail. */
export function useThreadRepos(active: boolean, repoPath: string | null, provided: RepoRegistryEntry[]) {
  const [registered, setRegistered] = useState<RepoRegistryEntry[]>([]);
  const needsLookup = Boolean(repoPath && !provided.some((repo) => repo.localPath === repoPath));
  useEffect(() => {
    if (!active || !needsLookup) return;
    const controller = new AbortController();
    void ipcFetch('/api/panel/repos', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as { repos?: RepoRegistryEntry[] };
        if (!controller.signal.aborted) setRegistered(payload.repos ?? []);
      })
      .catch(() => { /* Creation stays disabled when membership cannot be verified. */ });
    return () => controller.abort();
  }, [active, needsLookup, repoPath]);
  return provided.concat(registered.filter((entry) => !provided.some((repo) => repo.id === entry.id)));
}
