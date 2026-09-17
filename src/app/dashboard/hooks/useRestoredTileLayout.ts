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
  loadValidatedRestorePathsWithRetry,
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
  /** Bumps each time the registered-repo inventory finishes loading (useGlobalRepoState). */
  repoInventoryRevision?: number;
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
  repoInventoryRevision = 0,
}: UseRestoredTileLayoutArgs) {
  const [tileLayoutHydrated, setTileLayoutHydrated] = useState(false);
  // Keyed by repoPath VALUE, not tile id — blocking is a property of the
  // repo path, not of whichever leaf first referenced it. A leaf created
  // later (a split, or any code path that assigns an existing repoPath to a
  // different/new leaf id) that carries a still-unverified path is blocked
  // automatically; a leaf carrying a different, never-blocked path never is.
  const [blockedRepoPaths, setBlockedRepoPaths] = useState<Set<string>>(() => new Set());
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

  const validateLayout = useCallback(async (layout: TileLayout, withRetry = false) => {
    if (validationControllerRef.current) return null;
    const controller = new AbortController();
    const revision = layoutRevisionRef.current;
    validationControllerRef.current = controller;
    const validation = withRetry
      ? await loadValidatedRestorePathsWithRetry(layout, controller.signal, () => layoutRevisionRef.current === revision)
      : await loadValidatedRestorePaths(layout, controller.signal);
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
    // confirmed — mark every persisted path as pending up front so the tile
    // shows "Verifying…" instead of launching against an unverified repo
    // path while the network round trip is still in flight. This covers
    // every leaf carrying that path from the very first hydrated render,
    // including one created later by a split (see blockedRepoPaths above).
    setBlockedRepoPaths(new Set(persistedRepoScopes(restored).values()));

    void (async () => {
      const validation = await validateLayout(restored, true);
      if (cancelled || !mountedRef.current) return;
      if (!validation || !validation.ok) {
        // Either superseded mid-flight by another layout change, or the
        // round trip genuinely failed. Re-assert blocking for exactly the
        // paths THIS attempt was requested for — never a broader "whatever
        // is on screen now" snapshot, so a newer, unrelated scope the
        // operator already switched to is never retroactively blocked.
        // unverifiedRestoredRepoTileIds below further intersects this with
        // the CURRENT layout, so a tile the operator already rescoped away
        // from the failed path drops out on its own.
        setBlockedRepoPaths(new Set(persistedRepoScopes(restored).values()));
        setRestoredRepoValidationState('failed');
        return;
      }
      setTileLayout((current) => validatePersistedLayoutRepos(current, validation));
      setBlockedRepoPaths(new Set());
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
        setBlockedRepoPaths(new Set());
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

  // A failed validation re-runs on its own when the repo inventory finishes
  // loading and on the next window focus, so an operator who walks away from
  // a cold launch never returns to a dead end (#2456). Each trigger fires at
  // most once per failure: the retry flips the state to 'pending', which
  // tears these down until the next failure re-arms them.
  const handledInventoryRevisionRef = useRef(repoInventoryRevision);
  useEffect(() => {
    if (restoredRepoValidationState !== 'failed') return;
    if (handledInventoryRevisionRef.current === repoInventoryRevision) return;
    handledInventoryRevisionRef.current = repoInventoryRevision;
    retryRestoredRepoValidation();
  }, [repoInventoryRevision, restoredRepoValidationState, retryRestoredRepoValidation]);

  useEffect(() => {
    if (restoredRepoValidationState !== 'failed' || typeof window === 'undefined') return;
    const revalidateOnFocus = () => retryRestoredRepoValidation();
    const revalidateWhenVisible = () => {
      if (document.visibilityState === 'visible') retryRestoredRepoValidation();
    };
    window.addEventListener('focus', revalidateOnFocus);
    document.addEventListener('visibilitychange', revalidateWhenVisible);
    return () => {
      window.removeEventListener('focus', revalidateOnFocus);
      document.removeEventListener('visibilitychange', revalidateWhenVisible);
    };
  }, [restoredRepoValidationState, retryRestoredRepoValidation]);

  const unverifiedRestoredRepoTileIds = useMemo(() => {
    const currentScopes = persistedRepoScopes(tileLayout);
    return new Set(Array.from(currentScopes.entries())
      .filter(([, repoPath]) => blockedRepoPaths.has(repoPath))
      .map(([tileId]) => tileId));
  }, [blockedRepoPaths, tileLayout]);

  return {
    retryRestoredRepoValidation,
    restoredRepoValidationState,
    setTileLayoutHydrated,
    tileLayoutHydrated,
    unverifiedRestoredRepoTileIds,
  };
}
