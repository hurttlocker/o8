/**
 * #769 — Living Specs.
 *
 * After a packet's PR merges, append a one-line trailer to each directive
 * markdown file that matched the dispatch repo. The trailer accumulates
 * evidence that a merge respected (or violated) the directive — directives
 * stay human-authored, but each one carries a history of how the fleet
 * acted on it.
 *
 * Storage:
 *   ~/.o8/directives/<filename>.md
 *
 * Format (appended):
 *   ## Recent Merges
 *   - 2026-04-29 [merged] feat(orchestrator): packet title (#736)
 *   - 2026-04-28 [violated] fix(workspaces): tighten filter (#735)
 *
 * Behaviour:
 *   - Skip directives with `history: false` in front matter.
 *   - Filter by repo using the same scope rules `build-context.ts` uses.
 *   - Last 10 entries are kept; older ones are pruned in the same write.
 *   - Append-only — never rewrite existing directive body content. The
 *     `## Recent Merges` section is replaced with a fresh one each call;
 *     everything above it is preserved verbatim.
 *   - Helper never throws. A failure to update one directive is logged
 *     and swallowed so a merge never rolls back over a markdown bug.
 */

import 'server-only';

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { publishCortexChange } from '@/lib/realtime/publisher';

const MAX_TRAILER_ENTRIES = 10;
const SECTION_HEADER = '## Recent Merges';
const FRONT_MATTER_BOUNDARY = /^---\s*$/m;

export interface DirectiveTrailerEntry {
  /** ISO date YYYY-MM-DD. */
  date: string;
  /** `merged` for clean ships, `violated` when the review pass flagged a directive violation. */
  status: 'merged' | 'violated';
  /** Conventional-commit-style title (e.g. `feat(orchestrator): packet title`). */
  title: string;
  /** Optional GitHub issue/PR number to render as a `(#N)` suffix. */
  issueNumber?: number | null;
}

interface DirectiveMeta {
  id: string;
  /** Optional `title:` from front matter — used for `Spec-Update:` matching by title (#843). */
  title: string | null;
  scope: string;
  repoName: string | null;
  history: boolean;
}

interface ParsedDirective {
  meta: DirectiveMeta;
  /** Raw front-matter block + body, stopping right before the `## Recent Merges` section. */
  preserved: string;
  /** Existing trailer lines, oldest first. */
  trailerLines: string[];
}

/** Parse minimal front matter — just the keys we care about for filtering. */
function parseFrontMatter(text: string, fallbackId: string): DirectiveMeta {
  const result: DirectiveMeta = {
    id: fallbackId,
    title: null,
    scope: 'global',
    repoName: null,
    history: true,
  };

  if (!text.startsWith('---')) return result;

  const afterFirst = text.slice(3).trimStart();
  const closingIndex = afterFirst.search(FRONT_MATTER_BOUNDARY);
  if (closingIndex < 0) return result;

  const front = afterFirst.slice(0, closingIndex);
  for (const line of front.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    if (key === 'id') result.id = value || fallbackId;
    else if (key === 'title') result.title = value || null;
    else if (key === 'scope') result.scope = value || 'global';
    else if (key === 'repoName') result.repoName = value || null;
    else if (key === 'history') {
      // Treat unquoted `false` / `no` / `0` as opt-out. Default = true.
      const normalized = value.toLowerCase().replace(/['"`]/g, '');
      if (normalized === 'false' || normalized === 'no' || normalized === '0') {
        result.history = false;
      }
    }
  }

  return result;
}

/**
 * #843 — Parse `Spec-Update: <directive-name>` lines out of a commit message
 * so callers can target a single directive instead of blanket-appending.
 *
 * Convention (documented for future contributors):
 *   - One trailer per line, anywhere in the commit message body.
 *   - Format: `Spec-Update: <name>` where `<name>` matches a directive's
 *     `title` from its front matter, OR its filename (with or without `.md`),
 *     OR its `id`. Matching is case-insensitive and trims whitespace.
 *   - Multiple `Spec-Update:` lines append to each named directive in turn.
 *   - When no `Spec-Update:` line is present, the trailer falls back to the
 *     existing blanket-append behavior — every directive whose scope matches
 *     the merging repo gets the line.
 *
 * Returns the lower-cased target names. An empty array means "blanket
 * append" — no targeting requested.
 */
export function parseSpecUpdateTargets(commitMessage: string | null | undefined): string[] {
  if (!commitMessage) return [];
  const targets: string[] = [];
  for (const rawLine of commitMessage.split(/\r?\n/)) {
    const match = /^\s*Spec-Update:\s*(.+?)\s*$/i.exec(rawLine);
    if (!match) continue;
    const name = match[1].trim();
    if (!name) continue;
    targets.push(name.toLowerCase());
  }
  return targets;
}

/**
 * #843 — Does this directive match any of the requested `Spec-Update:`
 * targets? Returns true when targets is empty (no targeting → blanket).
 * Match keys: title, filename (with/without `.md`), and id — all
 * case-insensitive.
 */
function matchesSpecUpdateTargets(
  meta: DirectiveMeta,
  fileName: string,
  targets: string[],
): boolean {
  if (targets.length === 0) return true;
  const candidates = new Set<string>();
  if (meta.id) candidates.add(meta.id.toLowerCase());
  if (meta.title) candidates.add(meta.title.toLowerCase());
  if (fileName) {
    candidates.add(fileName.toLowerCase());
    candidates.add(fileName.replace(/\.md$/i, '').toLowerCase());
  }
  return targets.some((target) => candidates.has(target));
}

function splitOnRecentMerges(text: string): { before: string; section: string | null } {
  const re = new RegExp(`(^|\\n)${SECTION_HEADER}\\b[\\s\\S]*$`);
  const match = text.match(re);
  if (!match) return { before: text, section: null };
  const idx = text.indexOf(match[0]);
  const before = text.slice(0, idx);
  const section = text.slice(idx + (match[1] === '\n' ? 1 : 0));
  return { before, section };
}

function readTrailerLines(section: string | null): string[] {
  if (!section) return [];
  // Strip the header (and possibly leading newline) then collect `- ...` lines.
  const body = section.replace(new RegExp(`^${SECTION_HEADER}\\s*\\n?`), '');
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));
}

function parseDirective(raw: string, fallbackId: string): ParsedDirective {
  const text = raw.replace(/\r\n/g, '\n');
  const meta = parseFrontMatter(text, fallbackId);
  const { before, section } = splitOnRecentMerges(text);
  const preserved = before.replace(/\s*$/, '\n');
  const trailerLines = readTrailerLines(section);
  return { meta, preserved, trailerLines };
}

function formatTrailerLine(entry: DirectiveTrailerEntry): string {
  const issueSuffix =
    typeof entry.issueNumber === 'number' && Number.isFinite(entry.issueNumber)
      ? ` (#${entry.issueNumber})`
      : '';
  return `- ${entry.date} [${entry.status}] ${entry.title}${issueSuffix}`;
}

function renderRecentMergesSection(lines: string[]): string {
  const trimmed = lines.slice(-MAX_TRAILER_ENTRIES);
  return `${SECTION_HEADER}\n${trimmed.join('\n')}\n`;
}

function matchesRepoScope(meta: DirectiveMeta, repoPath: string): boolean {
  const repoName = basename(repoPath).toLowerCase();
  const scope = meta.scope.toLowerCase();
  if (scope === 'global' || scope === '') return true;
  const declared = (meta.repoName ?? '').toLowerCase();
  if (declared && declared === repoName) return true;
  if (scope === repoName) return true;
  return false;
}

function listDirectiveFiles(): { name: string; path: string }[] {
  try {
    const dir = join(getDataDir(), 'directives');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => ({ name, path: join(dir, name) }));
  } catch {
    return [];
  }
}

/**
 * Append a trailer entry to every directive matching the repo. Returns the
 * list of directive ids that were updated so callers can log + surface
 * the touch in telemetry. Never throws — per-file errors are logged.
 *
 * #843 — Optional `commitMessage` lets callers narrow the trailer to a
 * specific directive via `Spec-Update: <name>` lines in the commit body.
 * See `parseSpecUpdateTargets()` for the convention.
 */
export function appendDirectiveTrailer({
  repoPath,
  entry,
  commitMessage,
}: {
  repoPath: string;
  entry: DirectiveTrailerEntry;
  commitMessage?: string | null;
}): string[] {
  if (!repoPath?.trim()) return [];
  const updated: string[] = [];

  const files = listDirectiveFiles();
  if (files.length === 0) return [];

  const newLine = formatTrailerLine(entry);
  const specUpdateTargets = parseSpecUpdateTargets(commitMessage);

  for (const file of files) {
    try {
      const raw = readFileSync(file.path, 'utf-8');
      const fallbackId = file.name.replace(/\.md$/, '');
      const parsed = parseDirective(raw, fallbackId);
      if (!parsed.meta.history) continue;
      if (!matchesRepoScope(parsed.meta, repoPath)) continue;
      if (!matchesSpecUpdateTargets(parsed.meta, file.name, specUpdateTargets)) continue;

      // #841 — idempotency. If the exact same trailer line is already
      // present, skip the write so internal merges + the external-merge
      // watcher (which replays git log on a 5 min tick) never double up
      // on directives.
      if (parsed.trailerLines.includes(newLine)) continue;

      const merged = [...parsed.trailerLines, newLine];
      const section = renderRecentMergesSection(merged);
      const next = `${parsed.preserved}\n${section}`;

      // Only write when the rendered output changes — avoids touching mtime
      // for unrelated directives in the same dir.
      if (next !== raw) {
        writeFileSync(file.path, next, 'utf-8');
      }
      updated.push(parsed.meta.id);
    } catch (error) {
      console.warn(
        `[directive-merges] Failed to append trailer to ${file.name}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // #840 — Notify open Recall Cards / Packet Review Cards so the
  // freshly-appended trailer is visible without a manual collapse/reopen.
  // Fire-and-forget — never block the merge path on a websocket round-trip.
  // Co-located with the writer so any caller (merge handler, external-merge
  // handler #841, REPL smoke test) gets the broadcast automatically.
  if (updated.length > 0) {
    void publishCortexChange({
      scope: 'directive',
      repoPath,
      reason: `trailer:${entry.status}`,
    });
  }

  return updated;
}

/**
 * Read the latest N trailer lines for a directive id. Used by the API
 * surface that powers the Recall Card. Returns the lines newest-first so
 * the UI can render them top-down without sorting.
 */
export function readDirectiveTrailers(directiveId: string, limit = 3): string[] {
  if (!directiveId?.trim()) return [];
  try {
    const files = listDirectiveFiles();
    for (const file of files) {
      const fallbackId = file.name.replace(/\.md$/, '');
      const raw = readFileSync(file.path, 'utf-8');
      const parsed = parseDirective(raw, fallbackId);
      if (parsed.meta.id !== directiveId) continue;
      // Stored chronologically (oldest first); reverse + slice for newest-N.
      return parsed.trailerLines.slice(-limit).reverse();
    }
  } catch (error) {
    console.warn(
      `[directive-merges] Failed to read trailers for ${directiveId}:`,
      error instanceof Error ? error.message : error,
    );
  }
  return [];
}

/**
 * Read the latest trailer lines for every directive on disk, keyed by
 * directive id. Convenience for the API route so the recall-card surface
 * resolves trailers for all rows in one pass.
 */
export function readAllDirectiveTrailers(limit = 3): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  try {
    const files = listDirectiveFiles();
    for (const file of files) {
      try {
        const fallbackId = file.name.replace(/\.md$/, '');
        const raw = readFileSync(file.path, 'utf-8');
        const parsed = parseDirective(raw, fallbackId);
        const newest = parsed.trailerLines.slice(-limit).reverse();
        if (newest.length > 0) out[parsed.meta.id] = newest;
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // dir missing — empty map is the right answer
  }
  return out;
}
