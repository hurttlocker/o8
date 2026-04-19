/**
 * Pure, streaming-tolerant unified-diff parser.
 *
 * Input: a unified diff body (the content between ```diff ... ``` fences,
 *        or the raw body of a git diff).
 * Output: `{ filePath, status, hunks: [{ header, startLine, before, after }] }[]`
 *
 * Invariants:
 * - NEVER throws. Garbage input returns `[]`.
 * - Tolerates partial input (the last hunk may be incomplete while streaming).
 * - Returns whatever is parseable so far — callers that render a streaming
 *   diff will get a growing list of `hunks` between re-parses.
 *
 * This is the canonical parser for `DiffCard.tsx` (#525). Not to be confused
 * with `src/lib/worktree/diff-parser.ts` which parses `git diff` *sections*
 * for review/merge flows.
 */

export type ParsedDiffStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';

export interface ParsedDiffHunk {
  /** Raw @@ header line, e.g. '@@ -10,5 +10,7 @@ context' */
  header: string;
  /** First line number in the OLD file referenced by this hunk (1-based). */
  startOldLine: number;
  /** First line number in the NEW file referenced by this hunk (1-based). */
  startNewLine: number;
  /** Full set of hunk lines including the leading ' ', '+', '-', '\' markers. */
  lines: string[];
  /** Removed lines with leading '-' stripped. */
  before: string[];
  /** Added lines with leading '+' stripped. */
  after: string[];
}

export interface ParsedDiffFile {
  /** Target file path (the `+++` path when present, else `---`). */
  filePath: string;
  /** Old path for renames, otherwise equal to `filePath`. */
  oldPath: string;
  status: ParsedDiffStatus;
  hunks: ParsedDiffHunk[];
}

function stripPathPrefix(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === '/dev/null') return trimmed;
  // git produces paths like "a/src/foo.ts" / "b/src/foo.ts"
  if (/^[ab]\//.test(trimmed)) return trimmed.slice(2);
  return trimmed;
}

function parseHunkHeader(header: string): { startOldLine: number; startNewLine: number } {
  // @@ -old_start[,old_count] +new_start[,new_count] @@ [context]
  const match = header.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
  if (!match) return { startOldLine: 1, startNewLine: 1 };
  const startOldLine = Number.parseInt(match[1], 10);
  const startNewLine = Number.parseInt(match[2], 10);
  return {
    startOldLine: Number.isFinite(startOldLine) ? startOldLine : 1,
    startNewLine: Number.isFinite(startNewLine) ? startNewLine : 1,
  };
}

interface FileBuilder {
  filePath: string;
  oldPath: string;
  status: ParsedDiffStatus;
  hunks: ParsedDiffHunk[];
  currentHunk: ParsedDiffHunk | null;
}

function finishHunk(file: FileBuilder): void {
  if (!file.currentHunk) return;
  file.hunks.push(file.currentHunk);
  file.currentHunk = null;
}

function finishFile(file: FileBuilder | null, output: ParsedDiffFile[]): void {
  if (!file) return;
  finishHunk(file);
  if (!file.filePath && !file.oldPath) return;
  output.push({
    filePath: file.filePath || file.oldPath,
    oldPath: file.oldPath || file.filePath,
    status: file.status,
    hunks: file.hunks,
  });
}

/**
 * Parse a unified diff body into file-level entries.
 *
 * Accepts:
 * - Multi-file `diff --git a/foo b/foo` sections
 * - Single-file bodies with just `--- a/foo` / `+++ b/foo` / `@@` headers
 * - Partial input mid-stream (returns what's parseable so far)
 * - Garbage (returns `[]`)
 */
export function parseDiff(raw: string): ParsedDiffFile[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];

  try {
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const files: ParsedDiffFile[] = [];
    let current: FileBuilder | null = null;

    const startFile = (oldPath: string, newPath: string): FileBuilder => {
      const strippedOld = stripPathPrefix(oldPath);
      const strippedNew = stripPathPrefix(newPath);
      let status: ParsedDiffStatus = 'modified';
      if (strippedOld === '/dev/null') status = 'added';
      else if (strippedNew === '/dev/null') status = 'deleted';
      else if (strippedOld && strippedNew && strippedOld !== strippedNew) status = 'renamed';
      const builder: FileBuilder = {
        filePath: strippedNew && strippedNew !== '/dev/null' ? strippedNew : strippedOld,
        oldPath: strippedOld && strippedOld !== '/dev/null' ? strippedOld : strippedNew,
        status,
        hunks: [],
        currentHunk: null,
      };
      return builder;
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      // `diff --git a/foo b/foo` — seed a file with tentative paths.
      if (line.startsWith('diff --git ')) {
        finishFile(current, files);
        const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
        const oldPath = match?.[1] ?? '';
        const newPath = match?.[2] ?? oldPath;
        current = startFile(`a/${oldPath}`, `b/${newPath}`);
        continue;
      }

      // new / deleted file mode markers
      if (current && line.startsWith('new file mode')) {
        current.status = 'added';
        continue;
      }
      if (current && line.startsWith('deleted file mode')) {
        current.status = 'deleted';
        continue;
      }
      if (current && line.startsWith('rename from ')) {
        current.oldPath = line.slice('rename from '.length).trim();
        current.status = 'renamed';
        continue;
      }
      if (current && line.startsWith('rename to ')) {
        current.filePath = line.slice('rename to '.length).trim();
        current.status = 'renamed';
        continue;
      }

      // --- /+++ header pair — authoritative path for status + filePath
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        if (!current || current.currentHunk) {
          finishFile(current, files);
          current = startFile(line.slice(4), lines[i + 1].slice(4));
        } else {
          const strippedOld = stripPathPrefix(line.slice(4));
          const strippedNew = stripPathPrefix(lines[i + 1].slice(4));
          if (strippedOld === '/dev/null') current.status = 'added';
          else if (strippedNew === '/dev/null') current.status = 'deleted';
          if (strippedNew && strippedNew !== '/dev/null') current.filePath = strippedNew;
          if (strippedOld && strippedOld !== '/dev/null') current.oldPath = strippedOld;
        }
        i += 1; // consume the `+++` line too
        continue;
      }

      // Bare `--- ` without `+++ ` on the next line is not a file header; skip.

      // Hunk header
      if (line.startsWith('@@')) {
        if (!current) {
          // Unmounted hunk — accept it under a synthetic file so we don't drop data.
          current = {
            filePath: '',
            oldPath: '',
            status: 'unknown',
            hunks: [],
            currentHunk: null,
          };
        }
        finishHunk(current);
        const { startOldLine, startNewLine } = parseHunkHeader(line);
        current.currentHunk = {
          header: line,
          startOldLine,
          startNewLine,
          lines: [],
          before: [],
          after: [],
        };
        continue;
      }

      if (!current || !current.currentHunk) continue;

      // Hunk body
      current.currentHunk.lines.push(line);
      if (line.startsWith('+') && !line.startsWith('+++')) {
        current.currentHunk.after.push(line.slice(1));
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        current.currentHunk.before.push(line.slice(1));
      } else if (line.startsWith(' ')) {
        // Context line — belongs to both sides.
        current.currentHunk.before.push(line.slice(1));
        current.currentHunk.after.push(line.slice(1));
      }
      // '\' no-newline markers and blank trailing lines are preserved in `lines`
      // but don't contribute to before/after.
    }

    finishFile(current, files);
    // Drop synthetic empty-path files that never got a real filename.
    return files.filter((file) => file.filePath || file.oldPath);
  } catch {
    // Defensive — the parser is pure TS with no external deps, but the
    // contract is "never throw", so swallow and return empty.
    return [];
  }
}

/**
 * Count added / removed lines across all files & hunks.
 * Useful for the DiffCard summary badge.
 */
export function countDiffLines(files: ParsedDiffFile[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
        else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
      }
    }
  }
  return { added, removed };
}

/**
 * Re-serialise a subset of hunks into a unified diff body suitable for
 * `git apply`. Used by the partial-apply picker.
 *
 * `selection` maps a stable hunk key (`"${filePath}::${hunkIndex}"`) to a
 * boolean; when `true`, that hunk is included.
 */
export function serializeSelectedHunks(
  files: ParsedDiffFile[],
  selection: Record<string, boolean>,
): string {
  const out: string[] = [];
  for (const file of files) {
    const selectedHunks = file.hunks.filter((_, hunkIndex) => {
      const key = hunkKey(file, hunkIndex);
      return selection[key] !== false; // default-on when selection is empty
    });
    if (selectedHunks.length === 0) continue;

    // Minimal file header that `git apply` accepts.
    const oldGitPath = file.status === 'added' ? '/dev/null' : `a/${file.oldPath || file.filePath}`;
    const newGitPath = file.status === 'deleted' ? '/dev/null' : `b/${file.filePath}`;
    out.push(`diff --git ${oldGitPath} ${newGitPath}`);
    if (file.status === 'added') out.push('new file mode 100644');
    if (file.status === 'deleted') out.push('deleted file mode 100644');
    out.push(`--- ${oldGitPath}`);
    out.push(`+++ ${newGitPath}`);
    for (const hunk of selectedHunks) {
      out.push(hunk.header);
      for (const line of hunk.lines) out.push(line);
    }
  }
  // Trailing newline — `git apply` wants it.
  return out.length > 0 ? out.join('\n') + '\n' : '';
}

export function hunkKey(file: ParsedDiffFile, hunkIndex: number): string {
  return `${file.filePath || file.oldPath}::${hunkIndex}`;
}
