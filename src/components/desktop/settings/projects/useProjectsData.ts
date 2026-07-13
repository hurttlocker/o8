'use client';

/**
 * useProjectsData — data + mutations hook for the Settings → Projects panel.
 * Keeps the JSX in ProjectsPanel.tsx focused on layout and pulls the
 * fetch/refresh/diff plumbing into a dedicated hook.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { broadcastProjectsUpdated } from '@/components/desktop/repo-registry/useProjects';
import {
  fingerprintOrgSuggestion,
  parseGithubOrg,
  type DismissedApiResponse,
  type OrgSuggestion,
  type ProjectContextApiResponse,
  type ProjectContextView,
  type ProjectLocksApiResponse,
  type ProjectLockView,
  type ProjectsApiResponse,
  type RepoApiResponse,
} from './shared';
import type { FormState } from './ProjectForm';
import type {
  ProjectRole,
  ProjectWithRepos,
  SuggestionOrigin,
} from '@/lib/projects/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';

export interface ProjectsDataState {
  projects: ProjectWithRepos[];
  repos: RepoRegistryEntry[];
  reposById: Map<string, RepoRegistryEntry>;
  runtimeContext: ProjectContextView | null;
  projectLocks: ProjectLockView[];
  orgSuggestions: OrgSuggestion[];
  loading: boolean;
  topError: string | null;
  busyKey: string | null;
  setTopError: (next: string | null) => void;
  refresh: () => Promise<void>;
  submitCreate: (state: FormState, suggestionOrigin?: SuggestionOrigin) => Promise<void>;
  submitEdit: (projectId: string, before: ProjectWithRepos, state: FormState) => Promise<void>;
  handleDelete: (projectId: string) => Promise<void>;
  handleSetMainRepo: (projectId: string, repoId: string) => Promise<void>;
  handleRemoveRepo: (projectId: string, repoId: string) => Promise<void>;
  handleAddRepo: (projectId: string, repoId: string, role?: ProjectRole | null) => Promise<void>;
  handleArchiveLock: (laneId: string) => Promise<void>;
  handleDismissSuggestion: (suggestion: OrgSuggestion) => Promise<void>;
  handleGroupSuggestion: (suggestion: OrgSuggestion) => Promise<void>;
}

export function useProjectsData(): ProjectsDataState {
  const [projects, setProjects] = useState<ProjectWithRepos[]>([]);
  const [repos, setRepos] = useState<RepoRegistryEntry[]>([]);
  const [runtimeContext, setRuntimeContext] = useState<ProjectContextView | null>(null);
  const [projectLocks, setProjectLocks] = useState<ProjectLockView[]>([]);
  const [dismissedFingerprints, setDismissedFingerprints] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [topError, setTopError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const fetchedOnceRef = useRef(false);

  const reposById = useMemo(() => {
    const map = new Map<string, RepoRegistryEntry>();
    for (const repo of repos) map.set(repo.id, repo);
    return map;
  }, [repos]);

  const refresh = useCallback(async () => {
    try {
      const [projRes, repoRes, dismissedRes] = await Promise.all([
        fetch('/api/projects', { cache: 'no-store' }),
        fetch('/api/panel/repos', { cache: 'no-store' }),
        fetch('/api/projects/dismissed-suggestions', { cache: 'no-store' }),
      ]);
      const projData = (await projRes.json().catch(() => ({}))) as ProjectsApiResponse;
      const repoData = (await repoRes.json().catch(() => ({}))) as RepoApiResponse;
      const dismissedData = (await dismissedRes.json().catch(() => ({}))) as DismissedApiResponse;
      if (!projRes.ok) throw new Error(projData.error ?? 'Failed to load projects.');
      if (!repoRes.ok) throw new Error(repoData.error ?? 'Failed to load repos.');
      setProjects(projData.projects ?? []);
      setRepos(repoData.repos ?? []);
      setDismissedFingerprints(new Set(dismissedData.fingerprints ?? []));
      const [contextResult, locksResult] = await Promise.allSettled([
        fetch('/api/projects/context', { cache: 'no-store' }),
        fetch('/api/projects/locks', { cache: 'no-store' }),
      ]);
      if (contextResult.status === 'fulfilled') {
        const contextData = (await contextResult.value.json().catch(() => ({}))) as ProjectContextApiResponse;
        setRuntimeContext(contextResult.value.ok ? contextData.context ?? null : null);
      } else {
        setRuntimeContext(null);
      }
      if (locksResult.status === 'fulfilled') {
        const locksData = (await locksResult.value.json().catch(() => ({}))) as ProjectLocksApiResponse;
        setProjectLocks(locksResult.value.ok ? locksData.locks ?? [] : []);
      } else {
        setProjectLocks([]);
      }
      setTopError(null);
    } catch (err) {
      setTopError(err instanceof Error ? err.message : 'Failed to load projects.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (fetchedOnceRef.current) return;
    fetchedOnceRef.current = true;
    void refresh();
  }, [refresh]);

  const orgSuggestions = useMemo<OrgSuggestion[]>(() => {
    if (repos.length < 2) return [];

    const reposByOrg = new Map<string, RepoRegistryEntry[]>();
    for (const repo of repos) {
      const org = parseGithubOrg(repo.remoteUrl);
      if (!org) continue;
      const list = reposByOrg.get(org) ?? [];
      list.push(repo);
      reposByOrg.set(org, list);
    }

    const out: OrgSuggestion[] = [];
    for (const [org, orgRepos] of reposByOrg.entries()) {
      if (orgRepos.length < 2) continue;

      const orgRepoIds = new Set(orgRepos.map((r) => r.id));
      const assignedRepoIds = new Set(projects.flatMap((project) => (
        project.repos.map((link) => link.repoId)
      )));
      const existingMultiRepoProject = projects.some((project) => (
        project.repos.filter((link) => orgRepoIds.has(link.repoId)).length >= 2
      ));
      if (existingMultiRepoProject) continue;

      const candidateRepos = orgRepos.filter((repo) => !assignedRepoIds.has(repo.id));
      if (candidateRepos.length < 2) continue;

      const fingerprint = fingerprintOrgSuggestion(org, candidateRepos.map((r) => r.id));
      if (dismissedFingerprints.has(fingerprint)) continue;

      out.push({ org, repos: candidateRepos, fingerprint });
    }
    out.sort((a, b) => a.org.localeCompare(b.org));
    return out;
  }, [repos, projects, dismissedFingerprints]);

  const submitCreate = useCallback(async (state: FormState, suggestionOrigin: SuggestionOrigin = 'manual') => {
    setBusyKey('create');
    try {
      const repoIds: string[] = [];
      const roles: Record<string, ProjectRole> = {};
      for (const [repoId, role] of state.selected.entries()) {
        repoIds.push(repoId);
        if (role) roles[repoId] = role;
      }
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: state.name.trim(),
          slug: state.slug.trim() || undefined,
          description: state.description.trim() || null,
          mainRepoId: state.mainRepoId,
          repoIds,
          roles,
          suggestionOrigin,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to create project.');
      await refresh();
      // Broadcast so the left-rail useProjects hook drops its cache and
      // refetches. Without this the panel ledger reads stale even though
      // SQLite + ledger file on disk are correct.
      broadcastProjectsUpdated();
    } finally {
      setBusyKey(null);
    }
  }, [refresh]);

  const submitEdit = useCallback(async (projectId: string, before: ProjectWithRepos, state: FormState) => {
    setBusyKey(`edit:${projectId}`);
    try {
      // 1. Patch name + description
      const patchRes = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: state.name.trim(),
          description: state.description.trim() || null,
        }),
      });
      const patchData = (await patchRes.json().catch(() => ({}))) as { error?: string };
      if (!patchRes.ok) throw new Error(patchData.error ?? 'Failed to update project.');

      // 2. Diff repo set: removals → DELETE, additions → POST, role changes → PATCH
      const beforeRoles = new Map<string, ProjectRole | null>(before.repos.map((link) => [link.repoId, link.role]));
      const afterIds = new Set(state.selected.keys());
      // Removals
      for (const [repoId] of beforeRoles.entries()) {
        if (!afterIds.has(repoId)) {
          await fetch(`/api/projects/${projectId}/repos/${repoId}`, { method: 'DELETE' });
        }
      }
      // Additions + role updates
      for (const [repoId, role] of state.selected.entries()) {
        if (!beforeRoles.has(repoId)) {
          await fetch(`/api/projects/${projectId}/repos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoId, role }),
          });
        } else if ((beforeRoles.get(repoId) ?? null) !== role) {
          await fetch(`/api/projects/${projectId}/repos/${repoId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role }),
          });
        }
      }
      const nextMainRepoId = state.mainRepoId && state.selected.has(state.mainRepoId)
        ? state.mainRepoId
        : null;
      if ((before.mainRepoId ?? null) !== nextMainRepoId) {
        const mainRes = await fetch(`/api/projects/${projectId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mainRepoId: nextMainRepoId }),
        });
        const mainData = (await mainRes.json().catch(() => ({}))) as { error?: string };
        if (!mainRes.ok) throw new Error(mainData.error ?? 'Failed to update main repo.');
      }
      await refresh();
      // Broadcast so the left-rail useProjects hook drops its cache and
      // refetches. Without this the panel ledger reads stale even though
      // SQLite + ledger file on disk are correct.
      broadcastProjectsUpdated();
    } finally {
      setBusyKey(null);
    }
  }, [refresh]);

  const handleDelete = useCallback(async (projectId: string) => {
    setBusyKey(`delete:${projectId}`);
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? 'Failed to delete project.');
      }
      await refresh();
      broadcastProjectsUpdated();
    } catch (err) {
      setTopError(err instanceof Error ? err.message : 'Failed to delete project.');
    } finally {
      setBusyKey(null);
    }
  }, [refresh]);

  const handleSetMainRepo = useCallback(async (projectId: string, repoId: string) => {
    setBusyKey(`repo-main:${projectId}:${repoId}`);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mainRepoId: repoId }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to set main repo.');
      await refresh();
      broadcastProjectsUpdated();
    } catch (err) {
      setTopError(err instanceof Error ? err.message : 'Failed to set main repo.');
    } finally {
      setBusyKey(null);
    }
  }, [refresh]);

  const handleRemoveRepo = useCallback(async (projectId: string, repoId: string) => {
    setBusyKey(`repo-remove:${projectId}:${repoId}`);
    try {
      const res = await fetch(`/api/projects/${projectId}/repos/${repoId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? 'Failed to remove repo.');
      }
      await refresh();
      broadcastProjectsUpdated();
    } catch (err) {
      setTopError(err instanceof Error ? err.message : 'Failed to remove repo.');
    } finally {
      setBusyKey(null);
    }
  }, [refresh]);

  const handleAddRepo = useCallback(async (projectId: string, repoId: string, role: ProjectRole | null = null) => {
    setBusyKey(`repo-add:${projectId}:${repoId}`);
    try {
      const res = await fetch(`/api/projects/${projectId}/repos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId, role }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to add repo.');
      await refresh();
      broadcastProjectsUpdated();
    } catch (err) {
      setTopError(err instanceof Error ? err.message : 'Failed to add repo.');
    } finally {
      setBusyKey(null);
    }
  }, [refresh]);

  const handleArchiveLock = useCallback(async (laneId: string) => {
    setBusyKey(`archive-lock:${laneId}`);
    try {
      const res = await fetch(`/api/projects/locks/${laneId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'archive_stale' }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to archive lock.');
      await refresh();
    } catch (err) {
      setTopError(err instanceof Error ? err.message : 'Failed to archive lock.');
    } finally {
      setBusyKey(null);
    }
  }, [refresh]);

  const handleDismissSuggestion = useCallback(async (suggestion: OrgSuggestion) => {
    setBusyKey(`dismiss:${suggestion.fingerprint}`);
    // Optimistic update — dismissal is cheap and the strip reappearing on a
    // failed write would be more confusing than letting the user retry.
    setDismissedFingerprints((prev) => {
      const next = new Set(prev);
      next.add(suggestion.fingerprint);
      return next;
    });
    try {
      await fetch('/api/projects/dismissed-suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint: suggestion.fingerprint, reason: 'github-org-suggestion' }),
      });
    } catch {
      // Soft-fail — we keep the optimistic dismissal; refresh on next mount
      // will reconcile with server truth.
    } finally {
      setBusyKey(null);
    }
  }, []);

  const handleGroupSuggestion = useCallback(async (suggestion: OrgSuggestion) => {
    setBusyKey(`group:${suggestion.fingerprint}`);
    try {
      const repoIds = suggestion.repos.map((r) => r.id);
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: suggestion.org,
          repoIds,
          suggestionOrigin: 'github-org' satisfies SuggestionOrigin,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to create project from suggestion.');
      await refresh();
      broadcastProjectsUpdated();
    } catch (err) {
      setTopError(err instanceof Error ? err.message : 'Failed to create project.');
    } finally {
      setBusyKey(null);
    }
  }, [refresh]);

  return {
    projects,
    repos,
    reposById,
    runtimeContext,
    projectLocks,
    orgSuggestions,
    loading,
    topError,
    busyKey,
    setTopError,
    refresh,
    submitCreate,
    submitEdit,
    handleDelete,
    handleSetMainRepo,
    handleRemoveRepo,
    handleAddRepo,
    handleArchiveLock,
    handleDismissSuggestion,
    handleGroupSuggestion,
  };
}
