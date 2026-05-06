'use client';

import { useCallback, useEffect, useState } from 'react';

export interface ProjectRecord {
  id: string;
  name: string;
  repoPaths: string[];
  createdAt: string;
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
}

export function useProjects(): UseProjectsResult {
  const [ledger, setLedger] = useState<ProjectsLedger | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/panel/projects');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as ProjectsLedger;
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
      setLedger(data);
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
      setLedger(data);
      const created = data.projects.find((p) => p.id === data.activeProjectId) ?? null;
      return created;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
      return null;
    }
  }, []);

  const activeProject = ledger
    ? ledger.projects.find((p) => p.id === ledger.activeProjectId) ?? ledger.projects[0] ?? null
    : null;

  return { ledger, activeProject, loading, error, refresh, switchActive, createProject };
}
