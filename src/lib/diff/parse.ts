/**
 * Shared unified-diff parsing surface.
 *
 * The canonical implementation lives at `@/lib/llm/diff-parse` (it predates
 * this folder — used by `DiffCard` and the mobile diff viewer). This module
 * re-exports the same API under the `@/lib/diff/parse` path so the desktop
 * `InlineDiffViewer` (issue #659) and mobile `MobileDiffViewer` (#645) can
 * advertise a single, neutral import location.
 *
 * Do NOT diverge the implementation here — keep `diff-parse.ts` as the single
 * source of truth and let this file act as a thin alias.
 */
export {
  parseDiff,
  countDiffLines,
  serializeSelectedHunks,
  hunkKey,
} from '@/lib/llm/diff-parse';

export type {
  ParsedDiffFile,
  ParsedDiffHunk,
  ParsedDiffStatus,
} from '@/lib/llm/diff-parse';
