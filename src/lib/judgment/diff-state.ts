/**
 * Build the state a judgment question sees for one diff (#2434).
 *
 * The state carries only facts the referee cannot be told by the worker: the
 * git-derived file list (path, additions, deletions, mode change, symlink,
 * rename), the path-derived `docsOnly` flag, a hidden-text flag, and the diff
 * text. No worker-written title or summary: in the adversarial run a docs diff
 * with an auth-rewrite title flipped docs-only and touches-auth on 6 of 6.
 *
 * Files are sorted by path and hunks kept in file order so the same change
 * always serializes the same way (reversing file order shifted answers by up
 * to 0.12). The copy sent has line endings and whitespace normalized and
 * invisible controls shown as markers (see `text-scan.ts`). It is then cut to
 * a token budget: small files stay whole, large files keep head and tail,
 * every file and hunk header is kept, and the cut is marked.
 *
 * Trailer and reviewer-line stripping is hygiene, not the defense: a regex
 * cannot remove an approval claim written into code or data, which is why
 * the state carries nothing the worker authored beyond the diff itself.
 */
import { anyTextFlag, normalizeForJudgment, scanText, stripInvisible, type TextScanFlags } from './text-scan';

/** Diff chars per input token, measured on code diffs (3.24 on the calibration diff). */
export const DIFF_CHARS_PER_TOKEN = 3.2;
/** Token budget for the diff state. The provider rejected requests above ~32K tokens. */
export const DEFAULT_DIFF_BUDGET_TOKENS = 24_000;

/** One changed file as git reports it. Flags missing here are also read from the diff headers. */
export interface DiffStateFileInput {
  path: string;
  oldPath?: string | null;
  additions?: number;
  deletions?: number;
  modeChanged?: boolean;
  symlink?: boolean;
  renamed?: boolean;
}

export interface DiffStateFile {
  path: string;
  additions: number;
  deletions: number;
  modeChanged: boolean;
  symlink: boolean;
  renamed: boolean;
}

export interface DiffState {
  files: DiffStateFile[];
  docsOnly: boolean;
  /** Zero-width, bidi-control, mixed-script, or mixed line-ending text was found. */
  hiddenText: boolean;
  diff: string;
  truncated: boolean;
}

export interface BuiltDiffState {
  state: DiffState;
  truncated: boolean;
  hiddenText: boolean;
  textFlags: TextScanFlags;
  /** o8's own path check for middleware and auth code, shown beside the referee's advisory answer. */
  pathTouchesMiddlewareOrAuth: boolean;
  /**
   * Files that had a section in the diff but were missing from the caller's
   * list. They are added from the section headers and judged by the same docs
   * rule, so a short file list cannot hide a code file behind docsOnly.
   */
  filesAddedFromDiff: number;
  strippedLines: number;
  keptChars: number;
  fullChars: number;
}

const DOC_EXTENSION = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;
const MIDDLEWARE_OR_AUTH_PATH = /(?:^|[/._-])(?:middleware|auth|authz|authn|oauth|session|sessions|token|tokens|credential|credentials|permission|permissions|principal|secrets?)(?:[/._-]|$)/i;

/**
 * Normalize a git path: forward slashes, no `./` or empty segments. Returns
 * null for paths that must never count as docs: absolute paths and any `..`.
 */
export function normalizeDiffPath(raw: string): string | null {
  const unified = raw.replace(/\\/g, '/');
  if (unified.startsWith('/')) return null;
  const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;
  return segments.join('/');
}

export function pathTouchesMiddlewareOrAuth(filePath: string): boolean {
  return MIDDLEWARE_OR_AUTH_PATH.test(filePath);
}

interface SectionFacts {
  path: string | null;
  oldPath: string | null;
  modeChanged: boolean;
  symlink: boolean;
  renamed: boolean;
  binary: boolean;
}

function sectionFacts(section: string): SectionFacts {
  const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section);
  const renameFrom = /^rename from (.+)$/m.exec(section);
  return {
    path: header ? header[2] : null,
    oldPath: renameFrom ? renameFrom[1] : header ? header[1] : null,
    modeChanged: /^old mode \d+$/m.test(section) && /^new mode \d+$/m.test(section),
    symlink: /^(?:new file mode|deleted file mode|old mode|new mode) 120000$/m.test(section) || /^index [0-9a-f]+\.\.[0-9a-f]+ 120000$/m.test(section),
    renamed: Boolean(renameFrom) || Boolean(header && header[1] !== header[2]),
    binary: /^(?:Binary files |GIT binary patch)/m.test(section),
  };
}

/**
 * Docs means: a normalized path with a docs extension, text content, no mode
 * change, not a symlink, and (for a rename) a docs file on both sides. Never a
 * directory prefix: `docs/run.sh` is code.
 */
function isDocFile(file: DiffStateFile, oldPath: string | null, binary: boolean): boolean {
  if (file.modeChanged || file.symlink || binary) return false;
  if (normalizeDiffPath(file.path) === null || !DOC_EXTENSION.test(file.path)) return false;
  if (file.renamed && oldPath !== null && (normalizeDiffPath(oldPath) === null || !DOC_EXTENSION.test(oldPath))) return false;
  return true;
}

const TRAILER = /^(?:reviewed|signed-off|approved|acked|tested|reported|suggested|co-authored|lgtm)-by\s*:|^review[- ]status\s*:/i;
const REVIEWER_ADDRESS = new RegExp(
  '^(?:(?:dear|hey|hi|hello)\\s+)?'
  + '(?:(?:note|message|instructions?|attention|context)\\s+(?:to|for)\\s+(?:the\\s+|any\\s+|all\\s+)?)?'
  + '(?:code\\s+)?(?:@?reviewers?|approvers?|review(?:ing)?\\s+(?:agents?|models?|bots?|tools?)|judges?|referees?|graders?|evaluators?|merge[- ]gate(?:\\s+rule\\s+engine)?|rule[- ]engine|(?:ai|llm)\\s+(?:reviewers?|models?|assistants?))'
  + '\\s*[:,-]',
  'i',
);
// Comment leaders a trailer or address can hide behind: //, #, *, /*, <!--, --, ;
const COMMENT_LEADER = /^(?:\/\/+|\/\*+|\*+|#+|<!--|--|;+)\s*/;

/**
 * Trailers are removed wherever they appear outside removed lines. A reviewer
 * address is removed only where it reads as prose: inside a comment, in a
 * docs file, or in text outside any hunk. A code line such as
 * `reviewer: 'codex',` stays.
 */
function isInjectedLine(rawLine: string, proseSection: boolean): boolean {
  const line = stripInvisible(rawLine).replace(/[\u00A0\u2000-\u200A\u202F\u3000]/g, ' ');
  if (line.startsWith('+++') || line.startsWith('-') || isSkeleton(line)) return false;
  const prefixed = line.startsWith('+') || line.startsWith(' ');
  const body = (prefixed ? line.slice(1) : line).trimStart();
  const commented = COMMENT_LEADER.test(body);
  const content = body.replace(COMMENT_LEADER, '').trimStart();
  if (TRAILER.test(content)) return true;
  return (commented || proseSection || !prefixed) && REVIEWER_ADDRESS.test(content);
}

function isSkeleton(line: string): boolean {
  return line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')
  || line.startsWith('@@') || line.startsWith('new file mode') || line.startsWith('deleted file mode')
  || line.startsWith('similarity index') || line.startsWith('rename ') || line.startsWith('Binary files');
}

/** Split a unified diff into per-file sections; text before the first header is its own section. */
function splitSections(diffText: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git') && current.length > 0) {
      sections.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current.join('\n'));
  return sections.filter((section) => section.length > 0);
}

/** Hunks of a section in file order (by new-file start line), header lines first. */
function orderHunks(section: string): string {
  const lines = section.split('\n');
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  if (firstHunk < 0) return section;
  const hunks: string[][] = [];
  for (const line of lines.slice(firstHunk)) {
    if (line.startsWith('@@') || hunks.length === 0) hunks.push([]);
    hunks[hunks.length - 1].push(line);
  }
  const start = (hunk: string[]) => Number(/^@@ -\d+(?:,\d+)? \+(\d+)/.exec(hunk[0])?.[1] ?? 0);
  hunks.sort((a, b) => start(a) - start(b));
  return [...lines.slice(0, firstHunk), ...hunks.flat()].join('\n');
}

function countChanges(section: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of section.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

/** Chars a string costs inside the JSON request body (quotes excluded). */
const jsonLength = (text: string) => JSON.stringify(text).length - 2;
const MARKER_COST = 40;

/** Keep every header line, then head and tail body lines up to `budget` JSON chars. */
function fitSection(section: string, budget: number): string {
  if (jsonLength(section) <= budget) return section;
  const lines = section.split('\n');
  const cost = lines.map((line) => jsonLength(line) + 2);
  const keep = lines.map(isSkeleton);
  const skeletonCost = cost.reduce((sum, lineCost, index) => sum + (keep[index] ? lineCost : 0), 0);
  const markerReserve = (keep.filter(Boolean).length + 1) * MARKER_COST;
  const half = Math.max(0, (budget - skeletonCost - markerReserve) / 2);
  let headUsed = 0;
  let head = 0;
  for (; head < lines.length; head += 1) {
    if (keep[head]) continue;
    if (headUsed + cost[head] > half) break;
    keep[head] = true;
    headUsed += cost[head];
  }
  let tailUsed = 0;
  for (let tail = lines.length - 1; tail > head; tail -= 1) {
    if (keep[tail]) continue;
    if (tailUsed + cost[tail] > half) break;
    keep[tail] = true;
    tailUsed += cost[tail];
  }
  const out: string[] = [];
  let dropped = 0;
  lines.forEach((line, index) => {
    if (!keep[index]) { dropped += 1; return; }
    if (dropped) out.push(`[... ${dropped} lines truncated ...]`);
    dropped = 0;
    out.push(line);
  });
  if (dropped) out.push(`[... ${dropped} lines truncated ...]`);
  return out.join('\n');
}

export function buildDiffState(
  files: DiffStateFileInput[],
  diffText: string,
  budgetTokens: number = DEFAULT_DIFF_BUDGET_TOKENS,
): BuiltDiffState {
  const textFlags = scanText(diffText);
  const hiddenText = anyTextFlag(textFlags);
  const rawSections = splitSections(diffText.replace(/\r\n?/g, '\n'));
  const facts = new Map<string, SectionFacts & { additions: number; deletions: number }>();
  for (const section of rawSections) {
    const sectionFact = sectionFacts(section);
    if (sectionFact.path) facts.set(sectionFact.path, { ...sectionFact, ...countChanges(section) });
  }

  // A section the caller's list does not name still counts: add it from its
  // own headers so it reaches docsOnly and the path check.
  const listed = new Set(files.flatMap((file) => [file.path, normalizeDiffPath(file.path) ?? file.path]));
  const unlisted: DiffStateFileInput[] = [...facts.entries()]
    .filter(([sectionFile]) => !listed.has(sectionFile) && !listed.has(normalizeDiffPath(sectionFile) ?? sectionFile))
    .map(([sectionFile, fact]) => ({ path: sectionFile, oldPath: fact.oldPath }));

  const described = [...files, ...unlisted].map((file) => {
    const fact = facts.get(file.path);
    const stateFile: DiffStateFile = {
      path: normalizeDiffPath(file.path) ?? file.path,
      additions: typeof file.additions === 'number' ? file.additions : fact?.additions ?? 0,
      deletions: typeof file.deletions === 'number' ? file.deletions : fact?.deletions ?? 0,
      modeChanged: Boolean(file.modeChanged || fact?.modeChanged),
      symlink: Boolean(file.symlink || fact?.symlink),
      renamed: Boolean(file.renamed || fact?.renamed || (file.oldPath && file.oldPath !== file.path)),
    };
    const oldPath = file.oldPath ?? fact?.oldPath ?? null;
    return { stateFile, doc: isDocFile(stateFile, oldPath, fact?.binary ?? false), rawPath: file.path };
  }).sort((a, b) => (a.stateFile.path < b.stateFile.path ? -1 : a.stateFile.path > b.stateFile.path ? 1 : 0));
  const stateFiles = described.map((entry) => entry.stateFile);
  const docsOnly = described.length > 0 && described.every((entry) => entry.doc);
  const docPaths = new Set(described.filter((entry) => entry.doc).map((entry) => entry.rawPath));
  const pathAuth = described.some((entry) => pathTouchesMiddlewareOrAuth(entry.stateFile.path));

  let strippedLines = 0;
  const sections = rawSections
    .map((section) => ({ section, path: sectionFacts(section).path }))
    .sort((a, b) => {
      // Text before the first file header stays first; files follow by path.
      if (a.path === null || b.path === null) return a.path === null ? (b.path === null ? 0 : -1) : 1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    })
    .map(({ section, path }) => {
      const prose = path !== null && docPaths.has(path);
      const kept = section.split('\n').filter((line) => {
        if (!isInjectedLine(line, prose)) return true;
        strippedLines += 1;
        return false;
      }).join('\n');
      return normalizeForJudgment(orderHunks(kept));
    });
  const full = sections.join('\n');
  const extras = { hiddenText, textFlags, pathTouchesMiddlewareOrAuth: pathAuth, filesAddedFromDiff: unlisted.length, strippedLines };

  const overheadChars = JSON.stringify({ files: stateFiles, docsOnly, hiddenText, truncated: true }).length;
  const budgetChars = Math.max(0, Math.floor(budgetTokens * DIFF_CHARS_PER_TOKEN) - overheadChars);
  if (jsonLength(full) <= budgetChars) {
    return {
      state: { files: stateFiles, docsOnly, hiddenText, diff: full, truncated: false },
      truncated: false,
      ...extras,
      keptChars: full.length,
      fullChars: full.length,
    };
  }

  // Water-filling: smallest sections first each take up to an equal share of
  // what is left, so small files stay whole and large ones split the rest.
  const order = sections.map((_, index) => index).sort((a, b) => sections[a].length - sections[b].length);
  const fitted = new Array<string>(sections.length);
  let remaining = budgetChars - 240;
  order.forEach((index, position) => {
    const share = Math.max(0, Math.floor(remaining / (order.length - position)));
    fitted[index] = fitSection(sections[index], share);
    remaining -= jsonLength(fitted[index]) + 2;
  });
  let body = fitted.join('\n');
  // Headers alone can exceed the budget (thousands of files or hunks). The
  // request would be rejected, so cut the text and say so.
  if (jsonLength(body) > budgetChars - 240) {
    let end = Math.max(0, budgetChars - 400);
    while (end > 0 && jsonLength(body.slice(0, end)) > budgetChars - 400) end = Math.floor(end * 0.9);
    body = `${body.slice(0, end)}\n[... headers truncated: file and hunk headers exceed the budget ...]`;
  }
  const diff = `[diff truncated by o8 to fit about ${budgetTokens} tokens: kept ${body.length} of ${full.length} chars; every file and hunk header kept, large files shown head and tail]\n${body}`;
  return {
    state: { files: stateFiles, docsOnly, hiddenText, diff, truncated: true },
    truncated: true,
    ...extras,
    keptChars: body.length,
    fullChars: full.length,
  };
}
