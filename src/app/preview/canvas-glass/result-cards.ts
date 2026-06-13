'use client';

/**
 * Turn the orchestrator's live tool stream into the bench result cards
 * (#1232). The dock + chat-card already RENDER `result` entries (FilesResult /
 * PrResult in response-blocks.tsx); this is the missing wire — it watches a
 * turn's tool-use / tool-result events and, at turn end, synthesizes the
 * rolled-up artifacts:
 *   - Edit / Write / MultiEdit / NotebookEdit → one "Edited N files" card,
 *     file set + summed diff stats derived from the edit args.
 *   - a `gh pr create` shell whose output carries a PR URL → a PR card.
 *
 * Pure + framework-free so it unit-tests without a DOM. page.tsx owns one
 * accumulator per lane and calls record* on each event, synthesize* on `ready`.
 */

import type { NewDockEntry } from './ui';

/** Per-turn tool accumulator — one live instance per lane in page.tsx. */
export interface TurnTools {
  /** Unique edited file paths, first-seen order. */
  files: string[];
  /** Summed lines added / removed across every edit this turn. */
  adds: number;
  dels: number;
  /** A pull request opened this turn, if a `gh pr create` landed one. */
  pr: { number: number; repo?: string } | null;
}

export function emptyTurnTools(): TurnTools {
  return { files: [], adds: 0, dels: 0, pr: null };
}

/** Claude Code + Codex file-mutation tools. (Read/Bash/Grep don't count.) */
const FILE_EDIT_TOOLS = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
  'str_replace', 'str_replace_editor', 'create_file', 'apply_patch',
]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** Line count of a string chunk (0 for empty/missing — never NaN). */
const lines = (v: unknown): number => { const s = str(v); return s ? s.split('\n').length : 0; };

function filePathFrom(args: Record<string, unknown>): string | null {
  const fp = str(args.file_path) || str(args.path) || str(args.filename);
  return fp || null;
}

/** Added/removed line estimate for one edit, from its string args. A Write
 *  counts its content as adds (no prior content in the stream); an Edit nets
 *  old→new; a MultiEdit sums its edit list. Approximate by design — the stream
 *  carries the model's inputs, not a git diff. */
function statFrom(name: string, args: Record<string, unknown>): { adds: number; dels: number } {
  if (name === 'MultiEdit' && Array.isArray(args.edits)) {
    return args.edits.reduce<{ adds: number; dels: number }>((acc, raw) => {
      if (isRecord(raw)) { acc.adds += lines(raw.new_string); acc.dels += lines(raw.old_string); }
      return acc;
    }, { adds: 0, dels: 0 });
  }
  if (name === 'Write' || name === 'create_file') {
    return { adds: lines(args.content) || lines(args.file_text), dels: 0 };
  }
  // Edit / str_replace / apply_patch — net the replaced span.
  return { adds: lines(args.new_string), dels: lines(args.old_string) };
}

/** Fold a tool-use into the turn accumulator (mutates + returns it). */
export function recordTool(acc: TurnTools, name: string, args: Record<string, unknown> | undefined): TurnTools {
  if (!args || !FILE_EDIT_TOOLS.has(name)) return acc;
  const fp = filePathFrom(args);
  if (fp && !acc.files.includes(fp)) acc.files.push(fp);
  const { adds, dels } = statFrom(name, args);
  acc.adds += adds;
  acc.dels += dels;
  return acc;
}

/** Fold a tool-result — only `gh pr create` matters (PR number from its URL). */
export function recordToolResult(
  acc: TurnTools,
  name: string,
  args: Record<string, unknown> | undefined,
  output: string | undefined,
): TurnTools {
  const cmd = args ? str(args.command) : '';
  if (!/\bgh\s+pr\s+create\b/.test(cmd) || !output) return acc;
  const url = output.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/);
  if (url) { acc.pr = { number: Number(url[2]), repo: url[1] }; return acc; }
  const hash = output.match(/(?:^|\s)#(\d+)\b/);
  if (hash) acc.pr = { number: Number(hash[1]) };
  return acc;
}

/** Last two path segments — the card joins files on one truncating line, so a
 *  short tail reads better than a full repo-absolute path. */
function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : parts.slice(-2).join('/');
}

/** Synthesize the turn's result entries (called once, on `ready`). Empty when
 *  the turn only read / answered — no card for a no-op turn. */
export function synthesizeResultEntries(acc: TurnTools): NewDockEntry[] {
  const entries: NewDockEntry[] = [];
  if (acc.files.length > 0) {
    entries.push({
      role: 'result',
      kind: 'files',
      title: `Edited ${acc.files.length} file${acc.files.length === 1 ? '' : 's'}`,
      files: acc.files.map(shortPath),
      ...(acc.adds + acc.dels > 0 ? { adds: acc.adds, dels: acc.dels } : {}),
    });
  }
  if (acc.pr) {
    entries.push({
      role: 'result',
      kind: 'pr',
      title: 'Opened a pull request',
      prNumber: acc.pr.number,
      ...(acc.pr.repo ? { repo: acc.pr.repo } : {}),
      prState: 'open',
    });
  }
  return entries;
}
