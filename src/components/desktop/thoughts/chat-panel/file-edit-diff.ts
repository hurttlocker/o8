/**
 * file-edit-diff — the client seam for FileEditRow's inline peek (Wave 2,
 * dual-fidelity diff wiring).
 *
 * The peek fetches ONE file's working-tree diff from the same real endpoint the
 * Review/workspace surfaces use (`/api/panel/file-diff`, gated under
 * `/api/panel/`). That route returns `{ diff, hasDiff, isUntracked, path }` for
 * `git diff HEAD -- <path>` in the given workspace root. No new API surface.
 *
 * This module is pure so the URL construction + the honest empty-state
 * interpretation are testable without a live git repo (see
 * `file-edit-diff.test.ts`). The row component only wires state + fetch.
 */

export interface FileDiffResponse {
  diff?: string;
  stagedDiff?: string;
  hasDiff?: boolean;
  isUntracked?: boolean;
  path?: string;
  error?: string;
}

export type PeekOutcome =
  | { kind: 'diff'; diff: string; isUntracked: boolean }
  | { kind: 'empty'; reason: string }
  | { kind: 'error'; message: string };

/** Build the file-scoped diff URL. `path` is the file (absolute or repo-rel,
 *  matching the tool-call file_path); `repoPath` is the workspace root. */
export function buildFileDiffUrl(path: string, repoPath: string): string {
  const params = new URLSearchParams({ path, workspace: repoPath });
  return `/api/panel/file-diff?${params.toString()}`;
}

/** Normalize a network error into a calm, honest message. */
export function formatPeekError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/load failed|failed to fetch|networkerror/i.test(message)) {
    return 'Could not reach the local diff service.';
  }
  return message || 'Could not load this diff.';
}

/**
 * Interpret a `/api/panel/file-diff` response into exactly one of: a renderable
 * diff, an honest empty state, or an error. The empty case is load-bearing —
 * when the agent already committed the edit the working tree is clean and the
 * endpoint returns no diff; we say so rather than painting a blank box.
 */
export function interpretFileDiffResponse(data: FileDiffResponse | null | undefined): PeekOutcome {
  if (!data) return { kind: 'error', message: 'Could not load this diff.' };
  if (data.error) return { kind: 'error', message: data.error };

  const diff = (data.diff && data.diff.trim() ? data.diff : data.stagedDiff) ?? '';
  if (diff.trim()) {
    return { kind: 'diff', diff, isUntracked: data.isUntracked === true };
  }

  return {
    kind: 'empty',
    reason: 'No working-tree changes — already committed or reverted.',
  };
}
