'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { REQUEST_ADD_REPO_EVENT } from '@/lib/desktop/events';
import { AddRepoDialog } from './AddRepoDialog';
import type { RepoRegistryEntry } from './shared';
import { useProjects } from './useProjects';

type AddRepoMode = 'scratch' | 'existing';

/** One dashboard-owned host, independent of sidebar and hover-preview mounts. */
export function AddRepoFlowHost({
  onRepoAdded,
  onSelectRepo,
  onOpenChange,
}: {
  onRepoAdded?: (repo: RepoRegistryEntry) => void | Promise<void>;
  onSelectRepo?: (repoId: string) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const projects = useProjects();
  const [intent, setIntent] = useState<{ mode?: AddRepoMode } | null>(null);
  const openRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  useLayoutEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  useEffect(() => {
    const open = (event: Event) => {
      // Repeated entry-point events must not reset a form or launch another picker.
      if (openRef.current) return;
      openRef.current = true;
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const mode = (event as CustomEvent<{ mode?: AddRepoMode }>).detail?.mode;
      setIntent({ mode: mode === 'scratch' || mode === 'existing' ? mode : undefined });
      onOpenChangeRef.current?.(true);
    };
    window.addEventListener('o8:open-add-repo-flow', open);
    window.addEventListener(REQUEST_ADD_REPO_EVENT, open);
    return () => {
      window.removeEventListener('o8:open-add-repo-flow', open);
      window.removeEventListener(REQUEST_ADD_REPO_EVENT, open);
      onOpenChangeRef.current?.(false);
    };
  }, []);

  const close = useCallback(() => {
    openRef.current = false;
    setIntent(null);
    onOpenChangeRef.current?.(false);
    const trigger = returnFocusRef.current;
    if (trigger?.isConnected) trigger.focus();
    else if (trigger?.getAttribute('aria-label') === 'Add repository') {
      // The hover panel may have been replaced by the pinned sidebar.
      document.querySelector<HTMLElement>('[data-o8-agent-panel] [aria-label="Add repository"]')?.focus();
    }
  }, []);

  const handleRepoAdded = useCallback(async (repo: RepoRegistryEntry) => {
    await projects.refresh();
    await onRepoAdded?.(repo);
    onSelectRepo?.(repo.id);
    window.dispatchEvent(new CustomEvent('o8:repos-changed'));
  }, [onRepoAdded, onSelectRepo, projects]);

  return (
    <AddRepoDialog
      open={intent !== null}
      projects={projects.ledger?.projects ?? []}
      activeProjectId={projects.ledger?.activeProjectId ?? null}
      initialMode={intent?.mode}
      onClose={close}
      onRepoAdded={handleRepoAdded}
      onProjectsChanged={projects.refresh}
    />
  );
}
