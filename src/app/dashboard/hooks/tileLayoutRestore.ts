import { collectLeafNodes, replaceTileContent } from '@/lib/tiles/operations';
import type { TileLayout } from '@/lib/tiles/types';

export interface RestorePathValidation {
  ok: boolean;
  requestedPaths: string[];
  paths: Array<{ requestedPath: string; canonicalPath: string }>;
}

/**
 * Applies a validation result to whatever layout is passed in — the CURRENT
 * layout at apply time, not a snapshot captured when validation started. Only
 * leaves whose repoPath was part of THIS validation's requestedPaths are
 * touched; a repoPath the operator chose afterward (a newer, unrelated
 * scope) was never requested and is left alone, so a stale response can
 * never clobber a newer choice.
 */
export function validatePersistedLayoutRepos(
  layout: TileLayout,
  validation: Pick<RestorePathValidation, 'requestedPaths' | 'paths'>,
): TileLayout {
  const requestedPaths = new Set(validation.requestedPaths);
  const canonicalByRequestedPath = new Map(validation.paths.map((entry) => (
    [entry.requestedPath, entry.canonicalPath]
  )));
  let root = layout.root;
  for (const leaf of collectLeafNodes(layout.root)) {
    if (leaf.content.kind !== 'terminal' && leaf.content.kind !== 'canvas') continue;
    const repoPath = leaf.content.repoPath;
    if (!repoPath) continue;
    const trimmedPath = repoPath.trim();
    if (!requestedPaths.has(trimmedPath)) continue;
    const canonicalPath = canonicalByRequestedPath.get(trimmedPath) ?? null;
    if (canonicalPath === repoPath) continue;
    root = replaceTileContent(root, leaf.id, { ...leaf.content, repoPath: canonicalPath });
  }
  return root === layout.root ? layout : { ...layout, root };
}

export function collectPersistedRepoTileIds(layout: TileLayout): ReadonlySet<string> {
  return new Set(collectLeafNodes(layout.root)
    .filter((leaf) => (
      (leaf.content.kind === 'terminal' || leaf.content.kind === 'canvas')
      && Boolean(leaf.content.repoPath?.trim())
    ))
    .map((leaf) => leaf.id));
}

export async function loadValidatedRestorePaths(layout: TileLayout, signal?: AbortSignal): Promise<RestorePathValidation> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const abortValidation = () => controller.abort();
  const requestedPaths = new Set<string>();
  for (const leaf of collectLeafNodes(layout.root)) {
    if (leaf.content.kind !== 'terminal' && leaf.content.kind !== 'canvas') continue;
    const repoPath = leaf.content.repoPath?.trim();
    if (repoPath) requestedPaths.add(repoPath);
  }
  try {
    if (signal?.aborted) return { ok: false, requestedPaths: Array.from(requestedPaths), paths: [] };
    signal?.addEventListener('abort', abortValidation, { once: true });
    if (requestedPaths.size === 0) return { ok: true, requestedPaths: [], paths: [] };
    const searchParams = new URLSearchParams({ restoreValidationOnly: '1' });
    for (const repoPath of requestedPaths) searchParams.append('restorePath', repoPath);
    const result = await Promise.race([
      fetch(`/api/panel/repos?${searchParams.toString()}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
        signal: controller.signal,
      }).then(async (response) => (response.ok ? response.json().catch(() => null) : null)),
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, 2000);
      }),
    ]) as { validatedRestorePaths?: unknown } | null;
    if (!Array.isArray(result?.validatedRestorePaths)) {
      return { ok: false, requestedPaths: Array.from(requestedPaths), paths: [] };
    }
    const paths = result.validatedRestorePaths.filter((entry): entry is {
      requestedPath: string;
      canonicalPath: string;
    } => (
      typeof entry === 'object'
      && entry !== null
      && typeof (entry as { requestedPath?: unknown }).requestedPath === 'string'
      && typeof (entry as { canonicalPath?: unknown }).canonicalPath === 'string'
    ));
    return { ok: true, requestedPaths: Array.from(requestedPaths), paths };
  } catch {
    return { ok: false, requestedPaths: Array.from(requestedPaths), paths: [] };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortValidation);
  }
}
