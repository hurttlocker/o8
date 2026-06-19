import type { LoadedIssue } from './types';

/**
 * Voice/canvas spawn cap — "spawn N agents on X" tops out at 5 so a mishs-heard
 * number can't fan out a fleet. The orchestrator (DECOMPOSE) is the path for
 * larger, structured splits.
 */
export const SPAWN_PROMPT_MAX_AGENTS = 5;

const TITLE_MAX = 72;

function deriveTitle(task: string): string {
  const firstLine = task.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= TITLE_MAX) return collapsed;
  return `${collapsed.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

export function clampSpawnCount(count: number | undefined): number {
  if (!Number.isFinite(count)) return 1;
  return Math.max(1, Math.min(SPAWN_PROMPT_MAX_AGENTS, Math.floor(count as number)));
}

/**
 * Turn a free-form task into inline LoadedIssues for a gateless worktree spawn —
 * the seam voice ("spawn two agents on the auth refactor") and the canvas
 * `spawn-agents` verb both hit. Synthetic numbers start at 90001 with no URL, so
 * `isInlineIssue` treats them as ad-hoc tasks (inline/{slug} branches).
 *
 * For count > 1 the agents race the SAME task in independent worktrees; titles
 * carry an `(i/N)` suffix so the per-agent branch slugs (and card labels) stay
 * unique — same-title inline issues would collide on `inline/{slug}`.
 */
export function buildInlineIssuesFromPrompt(task: string, count = 1): LoadedIssue[] {
  const body = task.trim();
  if (!body) {
    throw new Error('task is required.');
  }
  const baseTitle = deriveTitle(body) || 'Inline task';
  const n = clampSpawnCount(count);

  return Array.from({ length: n }, (_unused, index) => ({
    number: 90001 + index,
    title: n === 1 ? baseTitle : `${baseTitle} (${index + 1}/${n})`,
    body,
    url: '',
  }));
}
