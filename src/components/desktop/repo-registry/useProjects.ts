'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchOnce } from '@/lib/panel/fetch-cache';

/** Window-level broadcast so every useProjects instance refreshes after any
 *  mutation (the palette + the AgentPanel + any future surface). Lets us
 *  skip lifting state to a single context without going stale.
 *
 *  Exported so the Settings → Projects hook can fire the same event after
 *  its own mutations (create / edit / delete) — otherwise the left-rail
 *  cache lags until the next mount. */
export const PROJECTS_UPDATED_EVENT = 'o8:projects-updated';

export function broadcastProjectsUpdated() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PROJECTS_UPDATED_EVENT));
}

/** Reload browser state after CLI or MCP mutations that cannot broadcast here. */
export function refreshProjectsFromExternalMutation() {
  if (typeof window === 'undefined') return;
  broadcastProjectsUpdated();
  window.dispatchEvent(new CustomEvent('o8:repos-changed'));
}

export const PROJECT_COLOR_PALETTE = [
  '#5b8db8',
  '#7fa68f',
  '#a39565',
  '#a37b7b',
  '#9079a8',
  '#7a9a8c',
  '#a87f5b',
  '#7a87a3',
] as const;

export type ProjectColor = typeof PROJECT_COLOR_PALETTE[number];

export interface ProjectRecord {
  id: string;
  name: string;
  repoPaths: string[];
  createdAt: string;
  color?: ProjectColor;
}

export interface ProjectsLedger {
  projects: ProjectRecord[];
  activeProjectId: string;
}

interface UseProjectsResult {
  ledger: ProjectsLedger | null;
  activeProject: ProjectRecord | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  switchActive: (projectId: string) => Promise<void>;
  createProject: (name: string) => Promise<ProjectRecord | null>;
  renameProject: (projectId: string, name: string) => Promise<boolean>;
  deleteProject: (projectId: string) => Promise<boolean>;
  moveRepoToProject: (repoPath: string, targetProjectId: string) => Promise<boolean>;
  setProjectColor: (projectId: string, color: ProjectColor) => Promise<boolean>;
}

export function useProjects(): UseProjectsResult {
  const [ledger, setLedger] = useState<ProjectsLedger | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetchOnce('/api/panel/projects');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as ProjectsLedger;
      // Don't broadcast on refresh — that would feed back into every other
      // instance's refresh listener and loop forever. Mutations broadcast.
      setLedger(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (typeof window === 'undefined') return;
    const handler = () => { void refresh(); };
    window.addEventListener(PROJECTS_UPDATED_EVENT, handler);
    return () => { window.removeEventListener(PROJECTS_UPDATED_EVENT, handler); };
  }, [refresh]);

  const switchActive = useCallback(async (projectId: string) => {
    setLedger((prev) => (prev ? { ...prev, activeProjectId: projectId } : prev));
    try {
      const res = await fetch('/api/panel/projects/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as ProjectsLedger;
      setLedger(data); broadcastProjectsUpdated();
    } catch {
      void refresh();
    }
  }, [refresh]);

  const createProject = useCallback(async (name: string) => {
    try {
      const res = await fetch('/api/panel/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      const data = await res.json() as ProjectsLedger;
      setLedger(data); broadcastProjectsUpdated();
      const created = data.projects.find((p) => p.id === data.activeProjectId) ?? null;
      return created;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
      return null;
    }
  }, []);

  const renameProject = useCallback(async (projectId: string, name: string) => {
    try {
      const res = await fetch(`/api/panel/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      const data = await res.json() as ProjectsLedger;
      setLedger(data); broadcastProjectsUpdated();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename project');
      return false;
    }
  }, []);

  const deleteProject = useCallback(async (projectId: string) => {
    try {
      const res = await fetch(`/api/panel/projects/${encodeURIComponent(projectId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      const data = await res.json() as ProjectsLedger;
      setLedger(data); broadcastProjectsUpdated();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete project');
      return false;
    }
  }, []);

  const moveRepoToProject = useCallback(async (repoPath: string, targetProjectId: string) => {
    if (!ledger) return false;
    const sourceProject = ledger.projects.find((p) => p.repoPaths.includes(repoPath));
    const targetProject = ledger.projects.find((p) => p.id === targetProjectId);
    if (!targetProject) return false;
    if (sourceProject?.id === targetProjectId) return true;

    try {
      // Remove from the source first (if any) so a transient state never has
      // the repo in two projects. Then add to the target.
      if (sourceProject) {
        const nextSource = sourceProject.repoPaths.filter((p) => p !== repoPath);
        const res = await fetch(`/api/panel/projects/${encodeURIComponent(sourceProject.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPaths: nextSource }),
        });
        if (!res.ok) throw new Error(`Failed to remove repo from ${sourceProject.name}`);
      }
      const nextTarget = Array.from(new Set([...targetProject.repoPaths, repoPath]));
      const res = await fetch(`/api/panel/projects/${encodeURIComponent(targetProject.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPaths: nextTarget }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || `Failed to add repo to ${targetProject.name}`);
      }
      const data = await res.json() as ProjectsLedger;
      setLedger(data); broadcastProjectsUpdated();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to move repo');
      void refresh();
      return false;
    }
  }, [ledger, refresh]);

  const setProjectColor = useCallback(async (projectId: string, color: ProjectColor) => {
    setLedger((prev) => (prev ? {
      ...prev,
      projects: prev.projects.map((p) => (p.id === projectId ? { ...p, color } : p)),
    } : prev));
    try {
      const res = await fetch(`/api/panel/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as ProjectsLedger;
      setLedger(data); broadcastProjectsUpdated();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set project color');
      void refresh();
      return false;
    }
  }, [refresh]);

  const activeProject = ledger
    ? ledger.projects.find((p) => p.id === ledger.activeProjectId) ?? ledger.projects[0] ?? null
    : null;

  return {
    ledger,
    activeProject,
    loading,
    error,
    refresh,
    switchActive,
    createProject,
    renameProject,
    deleteProject,
    moveRepoToProject,
    setProjectColor,
  };
}
