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

export const RESTORE_VALIDATION_ATTEMPT_TIMEOUT_MS = 7_000;
export const RESTORE_VALIDATION_BACKOFF_MS: readonly number[] = [0, 1_000, 3_000, 7_000];
export const RESTORE_VALIDATION_BUDGET_MS = 30_000;
const RESTORE_VALIDATION_MIN_ATTEMPT_MS = 1_000;

type RestoreValidationOutcome = 'ok' | 'timeout' | 'shape' | 'network' | `http:${number}`;

function collectRequestedRestorePaths(layout: TileLayout): string[] {
  const requestedPaths = new Set<string>();
  for (const leaf of collectLeafNodes(layout.root)) {
    if (leaf.content.kind !== 'terminal' && leaf.content.kind !== 'canvas') continue;
    const repoPath = leaf.content.repoPath?.trim();
    if (repoPath) requestedPaths.add(repoPath);
  }
  return Array.from(requestedPaths);
}

async function attemptRestorePathValidation(
  requestedPaths: string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
  attempt: number,
): Promise<RestorePathValidation> {
  const failed: RestorePathValidation = { ok: false, requestedPaths, paths: [] };
  if (signal?.aborted) return failed;
  const controller = new AbortController();
  const abortValidation = () => controller.abort();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const startedAt = Date.now();
  signal?.addEventListener('abort', abortValidation, { once: true });
  try {
    const searchParams = new URLSearchParams({ restoreValidationOnly: '1' });
    for (const repoPath of requestedPaths) searchParams.append('restorePath', repoPath);
    const settled = await Promise.race([
      fetch(`/api/panel/repos?${searchParams.toString()}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
        signal: controller.signal,
      }).then(async (response): Promise<{ outcome: RestoreValidationOutcome; body: unknown }> => (
        response.ok
          ? { outcome: 'ok', body: await response.json().catch(() => null) }
          : { outcome: `http:${response.status}`, body: null }
      ), (): { outcome: RestoreValidationOutcome; body: unknown } => ({ outcome: 'network', body: null })),
      new Promise<{ outcome: RestoreValidationOutcome; body: unknown }>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({ outcome: 'timeout', body: null });
          controller.abort();
        }, timeoutMs);
      }),
    ]);
    const result = settled.body as { validatedRestorePaths?: unknown } | null;
    let outcome = settled.outcome;
    if (outcome === 'ok' && !Array.isArray(result?.validatedRestorePaths)) outcome = 'shape';
    if (!signal?.aborted) {
      console.info(`[tile-restore] validation attempt ${attempt}: ${outcome} in ${Date.now() - startedAt}ms`);
    }
    if (outcome !== 'ok' || !Array.isArray(result?.validatedRestorePaths)) return failed;
    const paths = result.validatedRestorePaths.filter((entry): entry is {
      requestedPath: string;
      canonicalPath: string;
    } => (
      typeof entry === 'object'
      && entry !== null
      && typeof (entry as { requestedPath?: unknown }).requestedPath === 'string'
      && typeof (entry as { canonicalPath?: unknown }).canonicalPath === 'string'
    ));
    return { ok: true, requestedPaths, paths };
  } catch {
    return failed;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortValidation);
  }
}

function waitBeforeRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timeoutId);
      resolve(false);
    };
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** One validation round trip — the operator's Retry and the automatic re-validation triggers. */
export async function loadValidatedRestorePaths(
  layout: TileLayout,
  signal?: AbortSignal,
  timeoutMs = RESTORE_VALIDATION_ATTEMPT_TIMEOUT_MS,
): Promise<RestorePathValidation> {
  const requestedPaths = collectRequestedRestorePaths(layout);
  if (signal?.aborted) return { ok: false, requestedPaths, paths: [] };
  if (requestedPaths.length === 0) return { ok: true, requestedPaths: [], paths: [] };
  return attemptRestorePathValidation(requestedPaths, signal, timeoutMs, 1);
}

/**
 * Initial mount validation. The first API requests after launch race a cold
 * server, so a single short attempt dead-ends a healthy saved scope (#2456).
 * Retries with backoff inside a fixed budget; only an exhausted budget, an
 * abort, or `shouldContinue` returning false ends it without a result.
 */
export async function loadValidatedRestorePathsWithRetry(
  layout: TileLayout,
  signal?: AbortSignal,
  shouldContinue: () => boolean = () => true,
): Promise<RestorePathValidation> {
  const requestedPaths = collectRequestedRestorePaths(layout);
  let last: RestorePathValidation = { ok: false, requestedPaths, paths: [] };
  if (signal?.aborted) return last;
  if (requestedPaths.length === 0) return { ok: true, requestedPaths: [], paths: [] };
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    const backoffMs = RESTORE_VALIDATION_BACKOFF_MS[Math.min(attempt - 1, RESTORE_VALIDATION_BACKOFF_MS.length - 1)];
    const delayMs = Math.min(backoffMs, RESTORE_VALIDATION_BUDGET_MS - (Date.now() - startedAt));
    if (delayMs > 0 && !(await waitBeforeRetry(delayMs, signal))) return last;
    const remainingMs = RESTORE_VALIDATION_BUDGET_MS - (Date.now() - startedAt);
    if (signal?.aborted || !shouldContinue() || remainingMs < RESTORE_VALIDATION_MIN_ATTEMPT_MS) return last;
    last = await attemptRestorePathValidation(
      requestedPaths,
      signal,
      Math.min(RESTORE_VALIDATION_ATTEMPT_TIMEOUT_MS, remainingMs),
      attempt,
    );
    if (last.ok || signal?.aborted) return last;
  }
}
