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
  deserializeTileLayout,
  findTile,
  getFirstLeaf,
} from '@/lib/tiles/operations';
import type { TileLayout } from '@/lib/tiles/types';
import {
  loadValidatedRestorePaths,
  validatePersistedLayoutRepos,
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

  useEffect(() => {
    if (layoutRef.current === tileLayout) return;
    layoutRef.current = tileLayout;
    layoutRevisionRef.current += 1;
  }, [tileLayout]);

  const validateLayout = useCallback(async (layout: TileLayout) => {
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Establishes the saved tree BEFORE any ordinary edit can touch it, then
  // treats validation as a background annotation pass — never a snapshot
  // that gets reconstructed and replayed. Splitting, resizing, closing, or
  // wholesale replacing the scope while validation is still pending are all
  // just further edits to whatever is already live; validation, whenever it
  // resolves, can only patch the exact leaf/repoPath pairs it was asked
  // about (see validatePersistedLayoutRepos), so a stale response can never
  // resurrect a discarded scope or clobber a newer one (#2338).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    skipNextTileLayoutPersistenceRef.current = false;
    const restored = deserializeTileLayout(window.localStorage.getItem(storageKey));
    if (!restored) {
      setTileLayoutHydrated(true);
      return () => {
        cancelled = true;
      };
    }

    setTileLayout(restored);
    layoutRef.current = restored;
    layoutRevisionRef.current += 1;
    const storedActiveTileId = window.localStorage.getItem(activeTileStorageKey);
    const restoredActiveTileId = storedActiveTileId && findTile(restored.root, storedActiveTileId)
      ? storedActiveTileId
      : getFirstLeaf(restored.root).id;
    setActiveTileId(restoredActiveTileId);
    setTileLayoutHydrated(true);
    setRestoredRepoValidationState('pending');
    // Never expose a restored scope to a real terminal/canvas before it is
    // confirmed — mark every persisted scope as pending up front so the
    // tile shows "Verifying…" instead of launching against an unverified
    // repo path while the network round trip is still in flight.
    setBlockedRepoScopes(persistedRepoScopes(restored));

    void (async () => {
      const validation = await validateLayout(restored);
      if (cancelled || !mountedRef.current) return;
      if (!validation || !validation.ok) {
        // Either superseded mid-flight by another layout change, or the
        // round trip genuinely failed. Re-assert blocking for exactly the
        // scopes THIS attempt was requested for — never a broader "whatever
        // is on screen now" snapshot, so a newer, unrelated scope the
        // operator already switched to is never retroactively blocked.
        // unverifiedRestoredRepoTileIds below further intersects this with
        // the CURRENT layout, so a tile the operator already rescoped away
        // from the failed path drops out on its own.
        setBlockedRepoScopes(persistedRepoScopes(restored));
        setRestoredRepoValidationState('failed');
        return;
      }
      setTileLayout((current) => validatePersistedLayoutRepos(current, validation));
      setBlockedRepoScopes(new Map());
      setRestoredRepoValidationState('verified');
    })();

    return () => {
      cancelled = true;
      validationControllerRef.current?.abort();
      validationControllerRef.current = null;
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
            ? validatePersistedLayoutRepos(current, validation)
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
    restoredRepoValidationState,
    setTileLayoutHydrated,
    tileLayoutHydrated,
    unverifiedRestoredRepoTileIds,
  };
}
