import { collectLeafNodes, replaceTileContent } from '@/lib/tiles/operations';
import type { TileLayout } from '@/lib/tiles/types';

export interface RestorePathValidation {
  ok: boolean;
  paths: Array<{ requestedPath: string; canonicalPath: string }>;
}

export function validatePersistedLayoutRepos(
  layout: TileLayout,
  validatedRestorePaths: RestorePathValidation['paths'],
): TileLayout {
  const canonicalByRequestedPath = new Map(validatedRestorePaths.map((validation) => (
    [validation.requestedPath, validation.canonicalPath]
  )));
  let root = layout.root;
  for (const leaf of collectLeafNodes(layout.root)) {
    if (leaf.content.kind !== 'terminal' && leaf.content.kind !== 'canvas') continue;
    const repoPath = leaf.content.repoPath;
    if (!repoPath) continue;
    const canonicalPath = canonicalByRequestedPath.get(repoPath.trim()) ?? null;
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

export async function loadValidatedRestorePaths(layout: TileLayout): Promise<RestorePathValidation> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const searchParams = new URLSearchParams({ restoreValidationOnly: '1' });
    const requestedPaths = new Set<string>();
    for (const leaf of collectLeafNodes(layout.root)) {
      if (leaf.content.kind !== 'terminal' && leaf.content.kind !== 'canvas') continue;
      const repoPath = leaf.content.repoPath?.trim();
      if (repoPath) requestedPaths.add(repoPath);
    }
    if (requestedPaths.size === 0) return { ok: true, paths: [] };
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
    if (!Array.isArray(result?.validatedRestorePaths)) return { ok: false, paths: [] };
    const paths = result.validatedRestorePaths.filter((entry): entry is {
      requestedPath: string;
      canonicalPath: string;
    } => (
      typeof entry === 'object'
      && entry !== null
      && typeof (entry as { requestedPath?: unknown }).requestedPath === 'string'
      && typeof (entry as { canonicalPath?: unknown }).canonicalPath === 'string'
    ));
    return { ok: true, paths };
  } catch {
    return { ok: false, paths: [] };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
