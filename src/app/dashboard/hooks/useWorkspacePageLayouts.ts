import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { createDefaultTileLayout, deserializeTileLayout, getFirstLeaf, serializeTileLayout } from '@/lib/tiles/operations';
import type { TileLayout } from '@/lib/tiles/types';
import { loadValidatedRestorePaths, validatePersistedLayoutRepos } from './tileLayoutRestore';

const PAGE_LAYOUTS_KEY = 'o8:dashboard-page-layouts:v1';

interface WorkspacePageLayoutsArgs {
  activeTabId: string | null;
  hydrated: boolean;
  layout: TileLayout;
  setActiveTileId: Dispatch<SetStateAction<string | null>>;
  setLayout: Dispatch<SetStateAction<TileLayout>>;
}

/** The primary session tabs own pages; every page keeps its own split tree. */
export function useWorkspacePageLayouts({ activeTabId, hydrated, layout, setActiveTileId, setLayout }: WorkspacePageLayoutsArgs) {
  const layoutsRef = useRef(new Map<string, TileLayout>());
  const currentTabRef = useRef<string | null>(null);
  const layoutRef = useRef(layout);
  const pendingLayoutRef = useRef<TileLayout | null>(null);
  const validatedTabsRef = useRef(new Set<string>());
  const loadedRef = useRef(false);
  const revisionRef = useRef(0);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    layoutRef.current = layout;
    if (!currentTabRef.current) return;
    if (pendingLayoutRef.current && layout !== pendingLayoutRef.current) return;
    pendingLayoutRef.current = null;
    layoutsRef.current.set(currentTabRef.current, layout);
    validatedTabsRef.current.add(currentTabRef.current);
    if (typeof window === 'undefined') return;
    const saved = Object.fromEntries(Array.from(layoutsRef.current, ([id, page]) => [id, serializeTileLayout(page)]));
    window.localStorage.setItem(PAGE_LAYOUTS_KEY, JSON.stringify(saved));
  }, [layout]);

  useEffect(() => {
    if (!hydrated || !activeTabId || typeof window === 'undefined') return;
    if (!loadedRef.current) {
      loadedRef.current = true;
      try {
        const saved = JSON.parse(window.localStorage.getItem(PAGE_LAYOUTS_KEY) ?? '{}') as Record<string, unknown>;
        for (const [id, value] of Object.entries(saved)) {
          if (typeof value !== 'string') continue;
          const page = deserializeTileLayout(value);
          if (page) layoutsRef.current.set(id, page);
        }
      } catch {
        layoutsRef.current.clear();
      }
      currentTabRef.current = activeTabId;
      layoutsRef.current.set(activeTabId, layoutRef.current);
      validatedTabsRef.current.add(activeTabId);
      return;
    }
    if (activeTabId === currentTabRef.current) {
      revisionRef.current += 1;
      // Cancel a pending async restore when the operator returns to this page.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSwitching(false);
      return;
    }

    const revision = ++revisionRef.current;
    const next = layoutsRef.current.get(activeTabId) ?? createDefaultTileLayout();
    const activate = (safeNext: TileLayout) => {
      if (revision !== revisionRef.current) return;
      if (currentTabRef.current) layoutsRef.current.set(currentTabRef.current, layoutRef.current);
      currentTabRef.current = activeTabId;
      pendingLayoutRef.current = safeNext;
      layoutsRef.current.set(activeTabId, safeNext);
      validatedTabsRef.current.add(activeTabId);
      setLayout(safeNext);
      setActiveTileId(getFirstLeaf(safeNext.root).id);
      setSwitching(false);
    };
    if (validatedTabsRef.current.has(activeTabId) || !layoutsRef.current.has(activeTabId)) {
      activate(next);
      return;
    }
    setSwitching(true);
    void (async () => {
      // An inactive page's stored repo scope has not passed the active tile
      // restore gate. Validate it before that page mounts a live terminal.
      const validation = await loadValidatedRestorePaths(next);
      const safeNext = validatePersistedLayoutRepos(next, {
        requestedPaths: validation.requestedPaths,
        paths: validation.ok ? validation.paths : [],
      });
      activate(safeNext);
    })();
  }, [activeTabId, hydrated, setActiveTileId, setLayout]);

  return { switching };
}
