/**
 * Engineering Brain — Phase 2b: docs distillation (#915 north star follow-up).
 *
 * Walks every repo registered in `~/.o8/repos.json`, selects CLAUDE.md, root
 * README.md, AGENTS.md, DESIGN.md, and markdown at any depth under docs/, then
 * chunks them by heading and batches N chunks per Claude Sonnet call to extract
 * structured facts into the `facts` table.
 *
 * Why batched: the comment indexer (`scripts/indexer-run.ts`) burns ~2.2s of
 * CLI bootstrap per item. Packing 8 chunks per prompt amortizes that cost,
 * dropping per-chunk wall time roughly 5x while still letting the model see
 * each chunk independently.
 *
 * Idempotent on three levels:
 *   1. fingerprint upsert on `facts.fingerprint` (same as comment indexer).
 *   2. `doc_distill_state` per-chunk checkpoint — re-runs skip status='done'.
 *   3. mtime check — chunks whose file mtime is older than the existing
 *      fact's `created_at` are skipped without an LLM call.
 *
 * Usage:
 *   npx tsx scripts/distill-docs.ts                      # default whitelist
 *   npx tsx scripts/distill-docs.ts --dry-run            # plan only, no LLM
 *   npx tsx scripts/distill-docs.ts --batch=4            # smaller batches
 *   npx tsx scripts/distill-docs.ts --max-batches=2      # cap LLM calls
 *   npx tsx scripts/distill-docs.ts --include='**\/RFC*.md'
 *   npx tsx scripts/distill-docs.ts --exclude='**\/CHANGELOG.md'
 *   npx tsx scripts/distill-docs.ts --reset              # wipe checkpoint state
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type Database from 'better-sqlite3';

import { getDb, getSqlite } from '@/lib/db';
import { distillDocChunkBatch, type DocChunkInput } from '@/lib/cortex/indexer/doc-distill';
import { isWhitelistedDocPath } from '@/lib/cortex/indexer/doc-whitelist';

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_BATCH_TIMEOUT_MS = 240_000;
const HARD_CHUNK_CAP = 2000;
const MIN_CHUNK_LEN = 100;
const MIN_FILE_LEN = 200;
const MAX_FILE_BYTES = 100 * 1024;
const CONFIDENCE_FLOOR = 0.6;
const DOC_SOURCE_AUTHORITY = 0.85;

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'out',
  'target',
]);

// ── Args ─────────────────────────────────────────────────────────────────────

interface CliArgs {
  dryRun: boolean;
  batchSize: number;
  maxBatches: number | null;
  includes: string[];
  excludes: string[];
  reset: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    batchSize: DEFAULT_BATCH_SIZE,
    maxBatches: null,
    includes: [],
    excludes: [],
    reset: false,
  };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--reset') args.reset = true;
    else if (a.startsWith('--batch=')) {
      const n = Number(a.slice('--batch='.length));
      if (Number.isFinite(n) && n > 0) args.batchSize = Math.max(1, Math.min(32, Math.floor(n)));
    } else if (a.startsWith('--max-batches=')) {
      const n = Number(a.slice('--max-batches='.length));
      if (Number.isFinite(n) && n > 0) args.maxBatches = Math.floor(n);
    } else if (a.startsWith('--include=')) {
      args.includes.push(a.slice('--include='.length));
    } else if (a.startsWith('--exclude=')) {
      args.excludes.push(a.slice('--exclude='.length));
    }
  }
  return args;
}

// ── Repo registry ────────────────────────────────────────────────────────────

interface RegisteredRepo {
  name: string;
  localPath: string;
}

function getDataDir(): string {
  return (
    process.env.O8_DATA_DIR ||
    process.env.CORTEX_IDE_DATA_DIR ||
    path.join(os.homedir(), '.o8')
  );
}

function loadRegisteredRepos(): RegisteredRepo[] {
  const registryPath = path.join(getDataDir(), 'repos.json');
  if (!existsSync(registryPath)) return [];
  try {
    const raw = readFileSync(registryPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      repos?: Array<{ name?: string; localPath?: string; path?: string }>;
    };
    const out: RegisteredRepo[] = [];
    for (const entry of parsed.repos ?? []) {
      const localPath = entry?.localPath ?? entry?.path;
      if (!localPath) continue;
      const name = entry?.name ?? path.basename(localPath);
      out.push({ name, localPath: path.resolve(localPath) });
    }
    return out;
  } catch (err) {
    console.warn('[distill-docs] failed to read repos.json:', err instanceof Error ? err.message : err);
    return [];
  }
}

// ── File selection ───────────────────────────────────────────────────────────

interface CandidateFile {
  repo: RegisteredRepo;
  relPath: string;
  absPath: string;
  mtimeIso: string;
  bytes: number;
}

/**
 * Convert a glob to a regex. Supports ** (any depth), * (any non-slash chars),
 * and literal segment boundaries. Good enough for include/exclude flags;
 * we don't need a full minimatch impl.
 */
function globToRegex(glob: string): RegExp {
  // Escape regex metachars except *, ?, /.
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 2;
      // Eat trailing /
      if (glob[i] === '/') i += 1;
      continue;
    }
    if (c === '*') {
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    if ('.+^$|()[]{}\\'.includes(c)) {
      re += '\\' + c;
      i += 1;
      continue;
    }
    re += c;
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

function pathHasWorktreeSegment(p: string): boolean {
  // Match `.claude/worktrees`, `.cursor/worktrees`, `.o8/worktrees` anywhere.
  const segs = p.split(path.sep);
  for (let i = 0; i < segs.length - 1; i += 1) {
    if (
      (segs[i] === '.claude' || segs[i] === '.cursor' || segs[i] === '.o8') &&
      segs[i + 1] === 'worktrees'
    ) {
      return true;
    }
  }
  return false;
}

function isMarkdown(name: string): boolean {
  return /\.md$/i.test(name);
}

/**
 * Default whitelist matcher. True if relPath matches one of:
 *   - CLAUDE.md (any depth)
 *   - AGENTS.md (any depth)
 *   - DESIGN.md (any depth)
 *   - README.md (root only, depth 0)
 *   - markdown files at any depth under docs/
 *
 * Returning true here means "in scope before user --include/--exclude
 * overrides apply".
 */
export const defaultWhitelist = isWhitelistedDocPath;

/**
 * Walk a repo recursively yielding markdown files that match the default
 * whitelist OR a user-supplied --include glob. --exclude globs are honoured
 * after inclusion. Worktree directories and skip-dir patterns are pruned at
 * walk time so we never even stat the contents.
 */
function* walkRepoForDocs(
  repo: RegisteredRepo,
  includes: RegExp[],
  excludes: RegExp[],
): Generator<CandidateFile> {
  const stack: string[] = [repo.localPath];
  while (stack.length > 0) {
    const dir = stack.pop()!;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const name of entries) {
      const abs = path.join(dir, name);
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (SKIP_DIRECTORIES.has(name)) continue;
        if (pathHasWorktreeSegment(abs)) continue;
        stack.push(abs);
        continue;
      }
      if (!stat.isFile()) continue;
      if (!isMarkdown(name)) continue;

      const relPath = path.relative(repo.localPath, abs);

      // Selection: default whitelist OR explicit --include match.
      const whitelisted = defaultWhitelist(relPath);
      const includeMatch = includes.length > 0 && includes.some((re) => re.test(relPath));
      if (!whitelisted && !includeMatch) continue;

      // --exclude wins over both.
      if (excludes.some((re) => re.test(relPath))) continue;

      // Size cap.
      if (stat.size > MAX_FILE_BYTES) continue;

      yield {
        repo,
        relPath,
        absPath: abs,
        mtimeIso: stat.mtime.toISOString(),
        bytes: stat.size,
      };
    }
  }
}

// ── Chunking ─────────────────────────────────────────────────────────────────

interface DocChunk {
  chunkIdx: number;
  headingPath: string[];
  text: string;
  byteOffset: number;
}

/**
 * Semantic markdown chunker. Splits on H2 first, descends into H3 when an
 * H2 section exceeds the soft cap, then paragraph-splits when an H3 still
 * exceeds it. Carries the parent heading path on each chunk so downstream
 * prompts get section context without re-reading the file.
 */
function chunkMarkdown(body: string): DocChunk[] {
  const normalized = body.replace(/\r\n/g, '\n');

  // First: split on H2.
  const sections = splitOnHeading(normalized, /^##\s+(.+?)\s*$/m, 2);

  const out: DocChunk[] = [];
  let chunkIdx = 0;
  for (const section of sections) {
    // Each section either fits or needs further H3 splitting.
    if (section.text.length <= HARD_CHUNK_CAP) {
      if (section.text.trim().length >= MIN_CHUNK_LEN) {
        out.push({
          chunkIdx: chunkIdx++,
          headingPath: section.headingPath,
          text: section.text.trim(),
          byteOffset: section.byteOffset,
        });
      }
      continue;
    }

    // H3 split.
    const subsections = splitOnHeading(section.text, /^###\s+(.+?)\s*$/m, 3, section.headingPath);
    for (const sub of subsections) {
      const subOffset = section.byteOffset + sub.byteOffset;
      if (sub.text.length <= HARD_CHUNK_CAP) {
        if (sub.text.trim().length >= MIN_CHUNK_LEN) {
          out.push({
            chunkIdx: chunkIdx++,
            headingPath: sub.headingPath,
            text: sub.text.trim(),
            byteOffset: subOffset,
          });
        }
        continue;
      }

      // Paragraph split.
      const paras = splitOnParagraph(sub.text);
      for (const p of paras) {
        const text = p.text.trim();
        if (text.length < MIN_CHUNK_LEN) continue;
        out.push({
          chunkIdx: chunkIdx++,
          headingPath: sub.headingPath,
          text: text.length > HARD_CHUNK_CAP ? text.slice(0, HARD_CHUNK_CAP) : text,
          byteOffset: subOffset + p.byteOffset,
        });
      }
    }
  }

  return out;
}

interface HeadingSection {
  headingPath: string[];
  text: string;
  byteOffset: number;
}

/**
 * Split on heading lines at the given level. The text BEFORE the first
 * heading becomes section 0 (with the parent heading path). Each subsequent
 * section starts at the heading line and runs to the next heading at the
 * same level (or end of input).
 */
function splitOnHeading(
  body: string,
  headingRe: RegExp,
  level: number,
  parentPath: string[] = [],
): HeadingSection[] {
  // Find all heading positions at this level.
  const headingPattern = level === 2
    ? /^##\s+(.+?)\s*$/gm
    : /^###\s+(.+?)\s*$/gm;
  // Reset internal state by recreating with same flags.
  void headingRe;

  const matches: Array<{ start: number; end: number; title: string }> = [];
  for (const m of body.matchAll(headingPattern)) {
    if (m.index === undefined) continue;
    matches.push({ start: m.index, end: m.index + m[0].length, title: m[1] });
  }

  if (matches.length === 0) {
    return [{ headingPath: [...parentPath], text: body, byteOffset: 0 }];
  }

  const sections: HeadingSection[] = [];

  // Pre-heading prelude (only emit if non-trivial).
  if (matches[0].start > 0) {
    const prelude = body.slice(0, matches[0].start);
    if (prelude.trim().length > 0) {
      sections.push({ headingPath: [...parentPath], text: prelude, byteOffset: 0 });
    }
  }

  for (let i = 0; i < matches.length; i += 1) {
    const cur = matches[i];
    const next = matches[i + 1];
    const sectionEnd = next ? next.start : body.length;
    // Body for this section: everything AFTER the heading line itself.
    const text = body.slice(cur.end, sectionEnd);
    sections.push({
      headingPath: [...parentPath, cur.title.trim()],
      text,
      byteOffset: cur.end,
    });
  }

  return sections;
}

interface ParagraphChunk {
  text: string;
  byteOffset: number;
}

/**
 * Split on blank-line paragraph breaks. Aggregates contiguous paragraphs
 * into chunks that respect HARD_CHUNK_CAP without straddling boundaries —
 * we add paragraphs whole until the next would push us over the cap.
 */
function splitOnParagraph(text: string): ParagraphChunk[] {
  const paragraphs = text.split(/\n\s*\n/);
  const out: ParagraphChunk[] = [];
  let buffer = '';
  let bufferOffset = 0;
  let cursor = 0;

  for (const para of paragraphs) {
    const paraStart = text.indexOf(para, cursor);
    const adjOffset = paraStart >= 0 ? paraStart : cursor;
    cursor = adjOffset + para.length;

    if (buffer.length === 0) {
      buffer = para;
      bufferOffset = adjOffset;
      continue;
    }

    if (buffer.length + para.length + 2 > HARD_CHUNK_CAP) {
      out.push({ text: buffer, byteOffset: bufferOffset });
      buffer = para;
      bufferOffset = adjOffset;
    } else {
      buffer += '\n\n' + para;
    }
  }

  if (buffer.length > 0) out.push({ text: buffer, byteOffset: bufferOffset });
  return out;
}

// ── Source identity + fingerprint ────────────────────────────────────────────

function sourceIdOf(repoPath: string, relPath: string, chunkIdx: number): string {
  return `doc:${repoPath}:${relPath}:${chunkIdx}`;
}

function fingerprintOf(content: string, sourceId: string): string {
  return createHash('sha256').update(`${sourceId}\n${content}`).digest('hex');
}

// ── Checkpoint table ─────────────────────────────────────────────────────────

interface DistillStateRow {
  source_id: string;
  status: string;
  attempts: number;
  last_attempted_at: string | null;
  error: string | null;
  file_mtime: string | null;
}

function loadDistillState(sqlite: Database.Database): Map<string, DistillStateRow> {
  const rows = sqlite
    .prepare(
      `SELECT source_id, status, attempts, last_attempted_at, error, file_mtime
         FROM doc_distill_state`,
    )
    .all() as DistillStateRow[];
  return new Map(rows.map((r) => [r.source_id, r]));
}

function resetDistillState(sqlite: Database.Database): number {
  const result = sqlite.prepare(`DELETE FROM doc_distill_state`).run() as { changes?: number };
  return result.changes ?? 0;
}

function recordChunkOutcome(
  sqlite: Database.Database,
  sourceId: string,
  status: 'done' | 'failed',
  fileMtime: string,
  error: string | null,
  attemptsBefore: number,
): void {
  const upsert = sqlite.prepare(
    `INSERT INTO doc_distill_state
       (source_id, status, attempts, last_attempted_at, error, file_mtime, updated_at)
     VALUES (?, ?, ?, datetime('now'), ?, ?, datetime('now'))
     ON CONFLICT(source_id) DO UPDATE SET
       status = excluded.status,
       attempts = excluded.attempts,
       last_attempted_at = excluded.last_attempted_at,
       error = excluded.error,
       file_mtime = excluded.file_mtime,
       updated_at = excluded.updated_at`,
  );
  upsert.run(sourceId, status, attemptsBefore + 1, error, fileMtime);
}

// ── Mtime-fresh skip ─────────────────────────────────────────────────────────

interface ExistingFactRow {
  created_at: string;
}

function lookupExistingFact(
  sqlite: Database.Database,
  sourceId: string,
): ExistingFactRow | null {
  const row = sqlite
    .prepare(`SELECT created_at FROM facts WHERE source_id = ? LIMIT 1`)
    .get(sourceId) as ExistingFactRow | undefined;
  return row ?? null;
}

/**
 * Compare ISO-8601 timestamps with a SQLite-string-friendly normalization.
 * SQLite's `datetime('now')` writes `YYYY-MM-DD HH:MM:SS` (space separator);
 * `stat.mtime.toISOString()` returns `YYYY-MM-DDTHH:MM:SS.sssZ`. Convert both
 * to the same shape before comparing so we don't false-match on T vs space.
 */
function normalizeTimestamp(ts: string): string {
  return ts.replace('T', ' ').replace(/\..*$/, '').replace('Z', '').trim();
}

function isFileMtimeOlder(fileMtime: string, factCreatedAt: string): boolean {
  return normalizeTimestamp(fileMtime) <= normalizeTimestamp(factCreatedAt);
}

// ── Plan / batches ───────────────────────────────────────────────────────────

interface PlannedChunk {
  repo: RegisteredRepo;
  relPath: string;
  mtimeIso: string;
  chunk: DocChunk;
  sourceId: string;
}

interface ChunkPlan {
  files: number;
  filesInScope: number;
  chunksTotal: number;
  chunksDistilled: PlannedChunk[];
  chunksSkippedMtime: number;
  chunksSkippedDone: number;
}

function planChunks(
  args: CliArgs,
  sqlite: Database.Database,
  state: Map<string, DistillStateRow>,
): ChunkPlan {
  const repos = loadRegisteredRepos();
  const includeRegexes = args.includes.map(globToRegex);
  const excludeRegexes = args.excludes.map(globToRegex);

  const plan: ChunkPlan = {
    files: 0,
    filesInScope: 0,
    chunksTotal: 0,
    chunksDistilled: [],
    chunksSkippedMtime: 0,
    chunksSkippedDone: 0,
  };

  for (const repo of repos) {
    if (!existsSync(repo.localPath)) continue;
    for (const file of walkRepoForDocs(repo, includeRegexes, excludeRegexes)) {
      plan.files += 1;

      let body: string;
      try {
        body = readFileSync(file.absPath, 'utf-8');
      } catch {
        continue;
      }
      if (body.length < MIN_FILE_LEN) continue;

      plan.filesInScope += 1;

      const chunks = chunkMarkdown(body);
      for (const chunk of chunks) {
        plan.chunksTotal += 1;
        const sourceId = sourceIdOf(repo.localPath, file.relPath, chunk.chunkIdx);

        // 1. Already-done chunks (from checkpoint) skip immediately.
        const stateRow = state.get(sourceId);
        if (stateRow?.status === 'done') {
          plan.chunksSkippedDone += 1;
          continue;
        }

        // 2. Mtime-fresh skip — file unchanged since the existing fact was
        //    written. Avoids re-paying the LLM cost when the source-of-truth
        //    is identical.
        const existing = lookupExistingFact(sqlite, sourceId);
        if (existing && isFileMtimeOlder(file.mtimeIso, existing.created_at)) {
          plan.chunksSkippedMtime += 1;
          continue;
        }

        plan.chunksDistilled.push({
          repo,
          relPath: file.relPath,
          mtimeIso: file.mtimeIso,
          chunk,
          sourceId,
        });
      }
    }
  }

  return plan;
}

// ── Fact write ───────────────────────────────────────────────────────────────

interface WriteCounts {
  written: number;
  invalidExcerpt: number;
  invalidKind: number;
  belowFloor: number;
}

function writeFactsBatch(
  sqlite: Database.Database,
  rows: Array<{
    sourceId: string;
    repoPath: string;
    chunkText: string;
    extractedBy: string;
    fact: { kind: string; content: string; source_excerpt: string; confidence: number };
  }>,
): WriteCounts {
  const counts: WriteCounts = {
    written: 0,
    invalidExcerpt: 0,
    invalidKind: 0,
    belowFloor: 0,
  };
  if (rows.length === 0) return counts;

  const insert = sqlite.prepare(
    `INSERT INTO facts (
       id, kind, content, source_kind, source_id, source_excerpt,
       repo_path, confidence, fingerprint, extracted_by, source_authority
     )
     VALUES (?, ?, ?, 'doc', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(fingerprint) DO UPDATE SET
       kind = excluded.kind,
       content = excluded.content,
       source_excerpt = excluded.source_excerpt,
       repo_path = excluded.repo_path,
       confidence = excluded.confidence,
       extracted_by = excluded.extracted_by,
       source_authority = excluded.source_authority`,
  );

  const tx = sqlite.transaction((items: typeof rows) => {
    for (const row of items) {
      // Confidence floor.
      if (row.fact.confidence < CONFIDENCE_FLOOR) {
        counts.belowFloor += 1;
        continue;
      }
      // Excerpt must be a verbatim substring of the chunk.
      if (!row.chunkText.includes(row.fact.source_excerpt)) {
        counts.invalidExcerpt += 1;
        continue;
      }

      const fingerprint = fingerprintOf(row.fact.content, row.sourceId);
      insert.run(
        randomUUID(),
        row.fact.kind,
        row.fact.content,
        row.sourceId,
        row.fact.source_excerpt,
        row.repoPath,
        row.fact.confidence,
        fingerprint,
        row.extractedBy,
        DOC_SOURCE_AUTHORITY,
      );
      counts.written += 1;
    }
  });
  tx(rows);

  return counts;
}

// ── Driver ───────────────────────────────────────────────────────────────────

interface RunSummary {
  filesScanned: number;
  filesInScope: number;
  chunksTotal: number;
  chunksDistilled: number;
  chunksSkippedMtimeFresh: number;
  chunksSkippedDone: number;
  factsWritten: number;
  factsSkipped: number;
  llmBatches: number;
  estTokens: number;
  elapsedSeconds: number;
}

async function runBatches(
  sqlite: Database.Database,
  plan: ChunkPlan,
  args: CliArgs,
  state: Map<string, DistillStateRow>,
): Promise<{
  factsWritten: number;
  factsSkipped: number;
  batchesRun: number;
  estTokens: number;
}> {
  let factsWritten = 0;
  let factsSkipped = 0;
  let batchesRun = 0;
  let estTokens = 0;

  const queue = [...plan.chunksDistilled];
  const totalBatches = Math.ceil(queue.length / args.batchSize);

  while (queue.length > 0) {
    if (args.maxBatches !== null && batchesRun >= args.maxBatches) {
      console.log(
        `[distill-docs] reached --max-batches=${args.maxBatches}, stopping (${queue.length} chunks remaining)`,
      );
      break;
    }

    const batch = queue.splice(0, args.batchSize);
    batchesRun += 1;
    const batchLabel = `${batchesRun}/${totalBatches}`;
    const tStart = Date.now();

    const inputs: DocChunkInput[] = batch.map((p) => ({
      id: p.sourceId,
      repoName: p.repo.name,
      relPath: p.relPath,
      headingPath: p.chunk.headingPath,
      text: p.chunk.text,
    }));

    let perChunkFacts: Map<string, Array<{ kind: string; content: string; source_excerpt: string; confidence: number }>>;
    try {
      const result = await distillDocChunkBatch({
        chunks: inputs,
        timeoutMs: DEFAULT_BATCH_TIMEOUT_MS,
      });
      perChunkFacts = result.factsByChunkId;
      estTokens += result.estTokens;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[distill-docs] batch ${batchLabel} FAILED: ${message.slice(0, 240)}`);
      // Mark every chunk in the batch as failed so the next run retries them.
      for (const p of batch) {
        const prev = state.get(p.sourceId);
        recordChunkOutcome(sqlite, p.sourceId, 'failed', p.mtimeIso, message.slice(0, 400), prev?.attempts ?? 0);
      }
      continue;
    }

    // Write facts per chunk + checkpoint.
    const writeRows: Array<{
      sourceId: string;
      repoPath: string;
      chunkText: string;
      extractedBy: string;
      fact: { kind: string; content: string; source_excerpt: string; confidence: number };
    }> = [];
    const chunkSourceIds = new Set<string>();

    for (const p of batch) {
      chunkSourceIds.add(p.sourceId);
      const facts = perChunkFacts.get(p.sourceId) ?? [];
      for (const fact of facts) {
        writeRows.push({
          sourceId: p.sourceId,
          repoPath: p.repo.localPath,
          chunkText: p.chunk.text,
          extractedBy: 'doc-distill-batch',
          fact,
        });
      }
    }

    const counts = writeFactsBatch(sqlite, writeRows);
    factsWritten += counts.written;
    factsSkipped += counts.invalidExcerpt + counts.invalidKind + counts.belowFloor;

    // Mark every chunk in the batch as done (even those that produced 0 facts —
    // a TOC chunk legitimately has no facts and shouldn't be re-tried).
    for (const p of batch) {
      const prev = state.get(p.sourceId);
      recordChunkOutcome(sqlite, p.sourceId, 'done', p.mtimeIso, null, prev?.attempts ?? 0);
    }

    const ms = Date.now() - tStart;
    console.log(
      `[distill-docs] batch ${batchLabel} → ${counts.written} facts ` +
        `(invalid-excerpt=${counts.invalidExcerpt} below-floor=${counts.belowFloor}) ${(ms / 1000).toFixed(1)}s`,
    );
  }

  return { factsWritten, factsSkipped, batchesRun, estTokens };
}

async function main(): Promise<void> {
  const tStart = Date.now();
  const args = parseArgs(process.argv.slice(2));

  // Trigger DB migrations (incl. v19 doc_distill_state) before any access.
  const drizzle = getDb();
  if (!drizzle) {
    console.error('[distill-docs] DB unavailable — aborting');
    process.exit(1);
  }
  const sqlite = getSqlite();

  if (args.reset) {
    const removed = resetDistillState(sqlite);
    console.log(`[distill-docs] --reset: cleared ${removed} doc_distill_state rows`);
  }

  const state = loadDistillState(sqlite);
  console.log(
    `[distill-docs] loaded ${state.size} prior state rows (${Array.from(state.values()).filter((r) => r.status === 'done').length} done)`,
  );

  const plan = planChunks(args, sqlite, state);

  console.log(`[distill-docs] planning complete:`);
  console.log(`  files scanned    : ${plan.files}`);
  console.log(`  files in scope   : ${plan.filesInScope}`);
  console.log(`  chunks total     : ${plan.chunksTotal}`);
  console.log(`  chunks to distill: ${plan.chunksDistilled.length}`);
  console.log(`  skipped (done)   : ${plan.chunksSkippedDone}`);
  console.log(`  skipped (mtime)  : ${plan.chunksSkippedMtime}`);

  if (args.dryRun) {
    console.log('[distill-docs] --dry-run: no LLM calls, no writes. Exiting.');
    summarize({
      filesScanned: plan.files,
      filesInScope: plan.filesInScope,
      chunksTotal: plan.chunksTotal,
      chunksDistilled: 0,
      chunksSkippedMtimeFresh: plan.chunksSkippedMtime,
      chunksSkippedDone: plan.chunksSkippedDone,
      factsWritten: 0,
      factsSkipped: 0,
      llmBatches: 0,
      estTokens: 0,
      elapsedSeconds: (Date.now() - tStart) / 1000,
    });
    return;
  }

  if (plan.chunksDistilled.length === 0) {
    console.log('[distill-docs] nothing to distill — exiting clean.');
    summarize({
      filesScanned: plan.files,
      filesInScope: plan.filesInScope,
      chunksTotal: plan.chunksTotal,
      chunksDistilled: 0,
      chunksSkippedMtimeFresh: plan.chunksSkippedMtime,
      chunksSkippedDone: plan.chunksSkippedDone,
      factsWritten: 0,
      factsSkipped: 0,
      llmBatches: 0,
      estTokens: 0,
      elapsedSeconds: (Date.now() - tStart) / 1000,
    });
    return;
  }

  const totalBatches = Math.ceil(plan.chunksDistilled.length / args.batchSize);
  console.log(
    `[distill-docs] starting LLM phase: ${plan.chunksDistilled.length} chunks across ` +
      `${totalBatches} batches (size=${args.batchSize}). First call may be slow ` +
      `(Claude CLI bootstrap ~60s).`,
  );

  const { factsWritten, factsSkipped, batchesRun, estTokens } = await runBatches(
    sqlite,
    plan,
    args,
    state,
  );

  summarize({
    filesScanned: plan.files,
    filesInScope: plan.filesInScope,
    chunksTotal: plan.chunksTotal,
    chunksDistilled: batchesRun > 0 ? batchesRun * args.batchSize : 0,
    chunksSkippedMtimeFresh: plan.chunksSkippedMtime,
    chunksSkippedDone: plan.chunksSkippedDone,
    factsWritten,
    factsSkipped,
    llmBatches: batchesRun,
    estTokens,
    elapsedSeconds: (Date.now() - tStart) / 1000,
  });
}

function summarize(s: RunSummary): void {
  console.log('');
  console.log('────────────────────────────────────────────────────────────');
  console.log('[distill-docs] summary');
  console.log('────────────────────────────────────────────────────────────');
  console.log(`  files scanned    : ${s.filesScanned}`);
  console.log(`  files in scope   : ${s.filesInScope}`);
  console.log(`  chunks total     : ${s.chunksTotal}`);
  console.log(`  chunks distilled : ${s.chunksDistilled}`);
  console.log(`  chunks skipped   : ${s.chunksSkippedMtimeFresh} (mtime-fresh)`);
  console.log(`  chunks skipped   : ${s.chunksSkippedDone} (already done)`);
  console.log(`  facts written    : ${s.factsWritten}`);
  console.log(`  facts skipped    : ${s.factsSkipped} (invalid excerpt / kind / floor)`);
  console.log(`  llm batches      : ${s.llmBatches}`);
  console.log(`  llm tokens (est) : ${s.estTokens}`);
  console.log(`  elapsed          : ${s.elapsedSeconds.toFixed(1)}s`);
  console.log('────────────────────────────────────────────────────────────');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((err) => {
    console.error('[distill-docs] FAIL', err);
    process.exit(1);
  });
}
