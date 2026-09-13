import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import {
  collectLeafNodes,
  createDefaultTileLayout,
  deserializeTileLayout,
  findTile,
  getFirstLeaf,
  wrapRootWithSplit,
} from '@/lib/tiles/operations';
import type { TileContent, TileLayout, TileSplitDirection } from '@/lib/tiles/types';
import {
  loadValidatedRestorePaths,
  validatePersistedLayoutRepos,
  type RestorePathValidation,
} from './tileLayoutRestore';

export type RestoredRepoValidationState = 'idle' | 'pending' | 'failed' | 'verified';

interface UseRestoredTileLayoutArgs {
  activeTileStorageKey: string;
  setActiveTileId: Dispatch<SetStateAction<string | null>>;
  setTileLayout: Dispatch<SetStateAction<TileLayout>>;
  skipNextTileLayoutPersistenceRef: MutableRefObject<boolean>;
  storageKey: string;
  tileLayout: TileLayout;
  refreshRestoredRepoState: (validatedPaths: readonly string[], signal?: AbortSignal) => Promise<boolean>;
}

interface InitialRestoreSplit {
  content: TileContent;
  direction: TileSplitDirection;
  expectedLayout: TileLayout;
  ratio: number;
}

function persistedRepoScopes(layout: TileLayout): Map<string, string> {
  const scopes = new Map<string, string>();
  for (const leaf of collectLeafNodes(layout.root)) {
    if (leaf.content.kind !== 'terminal' && leaf.content.kind !== 'canvas') continue;
    const repoPath = leaf.content.repoPath?.trim();
    if (repoPath) scopes.set(leaf.id, repoPath);
  }
  return scopes;
}

export function useRestoredTileLayout({
  activeTileStorageKey,
  setActiveTileId,
  setTileLayout,
  skipNextTileLayoutPersistenceRef,
  storageKey,
  tileLayout,
  refreshRestoredRepoState,
}: UseRestoredTileLayoutArgs) {
  const [tileLayoutHydrated, setTileLayoutHydrated] = useState(false);
  const [blockedRepoScopes, setBlockedRepoScopes] = useState<Map<string, string>>(() => new Map());
  const [restoredRepoValidationState, setRestoredRepoValidationState] = useState<RestoredRepoValidationState>('idle');
  const layoutRef = useRef(tileLayout);
  const layoutRevisionRef = useRef(0);
  const mountedRef = useRef(true);
  const validationControllerRef = useRef<AbortController | null>(null);
  const retryInFlightRef = useRef(false);
  const initialRestorePendingRef = useRef(false);
  const initialRestoreSplitsRef = useRef<InitialRestoreSplit[]>([]);

  useEffect(() => {
    if (layoutRef.current === tileLayout) return;
    layoutRef.current = tileLayout;
    layoutRevisionRef.current += 1;
  }, [tileLayout]);

  const validateLayout = useCallback(async (layout: TileLayout): Promise<RestorePathValidation | null> => {
    if (validationControllerRef.current) return null;
    const controller = new AbortController();
    const revision = layoutRevisionRef.current;
    validationControllerRef.current = controller;
    const validation = await loadValidatedRestorePaths(layout, controller.signal);
    if (validationControllerRef.current === controller) {
      validationControllerRef.current = null;
    }
    if (
      controller.signal.aborted
      || layoutRevisionRef.current !== revision
    ) {
      return null;
    }
    return validation;
  }, []);

  const queueInitialRestoreSplit = useCallback((split: InitialRestoreSplit) => {
    if (!initialRestorePendingRef.current) return false;
    initialRestoreSplitsRef.current.push(split);
    return true;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    skipNextTileLayoutPersistenceRef.current = false;
    const restoreTimer = window.setTimeout(() => {
      void (async () => {
        const restored = deserializeTileLayout(window.localStorage.getItem(storageKey));
        initialRestorePendingRef.current = Boolean(restored);
        initialRestoreSplitsRef.current = [];
        const validation = restored ? await validateLayout(restored) : { ok: true, paths: [] };
        if (cancelled) return;
        const queuedSplits = initialRestoreSplitsRef.current;
        const preserveQueuedSplits = Boolean(
          restored
          && queuedSplits.length > 0
          && queuedSplits.at(-1)?.expectedLayout === layoutRef.current,
        );
        const restoredWithQueuedSplits = preserveQueuedSplits && restored
          ? queuedSplits.reduce((layout, split) => ({
            ...layout,
            root: wrapRootWithSplit(layout.root, split.direction, split.content, split.ratio).root,
          }), restored)
          : restored;
        const nextLayout = validation
          ? restoredWithQueuedSplits && validation.ok
            ? validatePersistedLayoutRepos(restoredWithQueuedSplits, validation.paths)
            : restoredWithQueuedSplits ?? createDefaultTileLayout()
          : preserveQueuedSplits
            ? restoredWithQueuedSplits!
            : layoutRef.current;
        const validationUnavailable = !validation || !validation.ok;
        setBlockedRepoScopes(validationUnavailable ? persistedRepoScopes(nextLayout) : new Map());
        setRestoredRepoValidationState(validationUnavailable ? 'failed' : 'verified');
        skipNextTileLayoutPersistenceRef.current = validationUnavailable;
        const storedActiveTileId = window.localStorage.getItem(activeTileStorageKey);
        const restoredActiveTileId = storedActiveTileId && findTile(nextLayout.root, storedActiveTileId)
          ? storedActiveTileId
          : getFirstLeaf(nextLayout.root).id;
        if (validation || preserveQueuedSplits) setTileLayout(nextLayout);
        setActiveTileId(restoredActiveTileId);
        setTileLayoutHydrated(true);
        initialRestorePendingRef.current = false;
      })();
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(restoreTimer);
      validationControllerRef.current?.abort();
      validationControllerRef.current = null;
      initialRestorePendingRef.current = false;
    };
  }, [activeTileStorageKey, setActiveTileId, setTileLayout, skipNextTileLayoutPersistenceRef, storageKey, validateLayout]);

  const retryRestoredRepoValidation = useCallback(() => {
    if (validationControllerRef.current || retryInFlightRef.current || restoredRepoValidationState === 'pending') return;
    const layoutAtStart = layoutRef.current;
    retryInFlightRef.current = true;
    setRestoredRepoValidationState('pending');
    void (async () => {
      try {
        const validation = await validateLayout(layoutAtStart);
        if (!validation || !mountedRef.current || layoutRef.current !== layoutAtStart) {
          if (mountedRef.current) setRestoredRepoValidationState('idle');
          return;
        }
        if (!validation.ok) {
          setRestoredRepoValidationState('failed');
          return;
        }
        const recoveryController = new AbortController();
        validationControllerRef.current = recoveryController;
        let refreshed = false;
        try {
          refreshed = await refreshRestoredRepoState(
            validation.paths.map((path) => path.canonicalPath),
            recoveryController.signal,
          );
        } finally {
          if (validationControllerRef.current === recoveryController) {
            validationControllerRef.current = null;
          }
        }
        if (!mountedRef.current || layoutRef.current !== layoutAtStart) {
          if (mountedRef.current) setRestoredRepoValidationState('idle');
          return;
        }
        if (!refreshed) {
          setRestoredRepoValidationState('failed');
          return;
        }
        setTileLayout((current) => (
          current === layoutAtStart
            ? validatePersistedLayoutRepos(current, validation.paths)
            : current
        ));
        setBlockedRepoScopes(new Map());
        setRestoredRepoValidationState('verified');
      } catch {
        if (mountedRef.current && layoutRef.current === layoutAtStart) {
          setRestoredRepoValidationState('failed');
        }
      } finally {
        retryInFlightRef.current = false;
      }
    })();
  }, [refreshRestoredRepoState, restoredRepoValidationState, setTileLayout, validateLayout]);

  const unverifiedRestoredRepoTileIds = useMemo(() => {
    const currentScopes = persistedRepoScopes(tileLayout);
    return new Set(Array.from(blockedRepoScopes.entries())
      .filter(([tileId, repoPath]) => currentScopes.get(tileId) === repoPath)
      .map(([tileId]) => tileId));
  }, [blockedRepoScopes, tileLayout]);

  return {
    retryRestoredRepoValidation,
    queueInitialRestoreSplit,
    restoredRepoValidationState,
    setTileLayoutHydrated,
    tileLayoutHydrated,
    unverifiedRestoredRepoTileIds,
  };
}
