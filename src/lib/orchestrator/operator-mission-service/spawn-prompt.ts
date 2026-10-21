import { constants as bufferConstants } from 'node:buffer';
import { getHeapStatistics } from 'node:v8';
import { extractPacketFileReferences } from '@/lib/orchestrator/packet-file-validator';
import { nextInlineIssueNumbers } from './shared';
import type { LoadedIssue } from './types';

const TITLE_MAX = 72;

function deriveTitle(task: string): string {
  const firstLine = task.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= TITLE_MAX) return collapsed;
  return `${collapsed.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

export function resolveSpawnCount(count: unknown): number {
  if (count === undefined) return 1;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
    throw new Error('count must be a positive safe integer.');
  }
  return count;
}

/**
 * This endpoint materializes the entire batch in arrays and serialized mission
 * snapshots. Reject a request that cannot fit before allocating any issues.
 * mission.ts stores task text in summary, prompt, and issue.body; constraints
 * and file-reference warnings appear in both summary and prompt. Count escaped
 * JSON characters for those fields without expanding count packets. Include all
 * referenced paths as a warning upper bound, even if they exist. Reserve 4 Ki
 * characters for each packet's titles/wrappers/metadata and the mission root.
 * For heap admission, budget two bytes per character and eight simultaneous
 * object/serialized copies during creation, dispatch, and persistence. Metadata
 * and live-copy reserves are estimates, not a worker concurrency or fleet cap.
 */
export function assertSpawnBatchMaterializable(task: string, count: number, constraints = '', repoPath = ''): void {
  const taskCharacters = JSON.stringify(task).length;
  const constraintCharacters = JSON.stringify(constraints).length;
  const repoCharacters = JSON.stringify(repoPath).length;
  const references = new Set([...extractPacketFileReferences(task), ...extractPacketFileReferences(constraints)]);
  // JSON-escaped header plus each escaped path, list prefix, and newline.
  const warningCharacters = 40 + [...references].reduce((total, path) => total + JSON.stringify(path).length + 6, 0);
  const packetCharacters = taskCharacters * 3 + constraintCharacters * 2
    + warningCharacters * 2 + repoCharacters * 2 + 4096;
  // Mission-level prompt and constraints also retain the constraint text.
  const snapshotCharacters = packetCharacters * count + constraintCharacters * 2 + repoCharacters * 2 + 4096;
  if (count > 0xffff_ffff
    || snapshotCharacters > bufferConstants.MAX_STRING_LENGTH
    || snapshotCharacters * 2 * 8 > getHeapStatistics().total_available_size) {
    throw new Error('Spawn batch exceeds this process\'s array, serialization, or available heap capacity. Submit smaller batches; no tasks were created.');
  }
}

/**
 * Turn a free-form task into inline LoadedIssues for a gateless worktree spawn —
 * the seam voice ("spawn two agents on the auth refactor") and the canvas
 * `spawn-agents` verb both hit. Synthetic numbers start at 90001 with no URL, so
 * `isInlineIssue` treats them as ad-hoc tasks (inline/{slug} branches).
 *
 * For count > 1 the agents race the SAME task in independent worktrees; titles
 * carry an `(i/N)` suffix so the per-agent branch slugs (and card labels) stay
 * unique — they feed the mission branch target's `inline/{number}-{slug}` prefix.
 */
export function buildInlineIssuesFromPrompt(task: string, count = 1): LoadedIssue[] {
  const body = task.trim();
  if (!body) {
    throw new Error('task is required.');
  }
  const baseTitle = deriveTitle(body) || 'Inline task';
  const n = resolveSpawnCount(count);
  assertSpawnBatchMaterializable(body, n);

  const numbers = nextInlineIssueNumbers(n);
  return Array.from({ length: n }, (_unused, index) => ({
    number: numbers[index]!,
    title: n === 1 ? baseTitle : `${baseTitle} (${index + 1}/${n})`,
    body,
    url: '',
  }));
}
