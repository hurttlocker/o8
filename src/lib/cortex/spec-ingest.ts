/**
 * spec-ingest — auto-ingest a repo's authoritative markdown specs as
 * `scope: repo` directives so the Engineering Brain (#915) has substrate to
 * answer design / convention / "how do we do X here" questions.
 *
 * Scope per #1114:
 *   - Named files: README.md, CLAUDE.md, AGENTS.md, THEME.md,
 *     docs/design/DESIGN.md, docs/design/STYLEGUIDE.md
 *   - Directories: docs/** (recursive, *.md only)
 *
 * Chunking (#1120):
 *   Base unit is one directive per H2 section. The text BEFORE the first H2
 *   becomes an "Overview" chunk. Sections shorter than 40 chars are skipped
 *   (likely stubs or empty headers).
 *
 *   An H2 is FURTHER split into per-H3 sub-chunks when either:
 *     - it has 3+ H3 children (rule of thumb: 7 motifs under §06 collapse
 *       into one ~14KB chunk otherwise), OR
 *     - the full H2 body exceeds H3_SPLIT_BODY_CHARS (4000)
 *   In that case the H2 produces no rolled-up chunk on its own — only its
 *   H3 sub-chunks (plus any preamble before the first H3, attached to the
 *   first H3 chunk if non-trivial). If neither threshold is hit, the H2
 *   stays as a single chunk as before.
 *
 * Idempotency:
 *   All directive IDs begin with `spec-ingest:<repoSlug>:`. Re-running
 *   delete-then-writes so re-ingest on the same repo doesn't duplicate.
 *   H3 IDs use the colon-extended form
 *   `spec-ingest:<repoSlug>:<file>:<h2-slug>:<h3-slug>` and still match the
 *   `spec-ingest:<repoSlug>:` prefix used by deletePriorSpecDirectives.
 *
 * Filenames:
 *   Directive files live in <dataDir>/directives/. The directive ID can
 *   contain colons (matches the existing directive-file convention), but
 *   we replace colons with `__` in the filename so the path is portable
 *   across filesystems. The `id:` in the front matter keeps the colons.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { getSqlite } from '@/lib/db';
import { refreshDirectiveFts } from '@/lib/db/v14-fts5-migration';
import { captionImagesInSpec } from '@/lib/cortex/spec-image-captions';
import { invalidateAnswerCache } from '@/lib/cortex/qa/ask';

const ROOT_SPEC_FILES = [
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  'docs/design/DESIGN.md',
  'THEME.md',
  'docs/design/STYLEGUIDE.md',
] as const;
const SPEC_SUBDIRS = ['docs'] as const;
const MIN_SECTION_BODY_CHARS = 40;
const MAX_FRONT_MATTER_TITLE_CHARS = 160;
const MAX_DIRECTIVE_BODY_CHARS = 16_000;
const DIRECTIVE_ID_PREFIX = 'spec-ingest';

// H3 split thresholds (#1120). An H2 splits into per-H3 chunks when EITHER
// is true. Tuned for docs/design/DESIGN.md §06 Motifs (7 H3 kids, ~4.1 KB body): both
// trigger, so we always split it.
const H3_SPLIT_MIN_CHILDREN = 3;
const H3_SPLIT_BODY_CHARS = 4000;

export interface SpecIngestResult {
  scannedFiles: number;
  writtenDirectives: number;
  deletedStaleDirectives: number;
  files: string[];
}

interface DocSection {
  // Slug fragment for the H2 (e.g. "06-motifs").
  slug: string;
  // Optional H3 sub-slug (e.g. "06-7-flat-icon-button-locked-the-button-language").
  // When present, the directive ID is `<...>:<slug>:<subSlug>`.
  subSlug?: string;
  // Heading line shown inside the directive markdown body and in the title.
  // For H3 chunks this is "H2 — H3" so the chunk's anchoring is unambiguous
  // when surfaced as a citation in cortex_ask.
  heading: string;
  body: string;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function stripFrontMatter(md: string): string {
  if (!md.startsWith('---')) return md;
  const closing = md.indexOf('\n---', 3);
  if (closing < 0) return md;
  return md.slice(closing + 4).replace(/^\s*\n/, '');
}

interface RawH2 {
  heading: string;
  slug: string;
  rawBody: string; // includes any nested H3 lines verbatim
}

/**
 * Pass 1: split markdown into H2 sections only. Content before the first
 * H2 becomes an Overview section. Bodies still contain their `### ` H3
 * subheadings — splitH2IntoH3s handles them.
 */
function splitByH2(md: string): RawH2[] {
  const body = stripFrontMatter(md);
  const lines = body.split('\n');
  const sections: RawH2[] = [];

  let currentHeading = 'Overview';
  let currentSlug = 'overview';
  let currentLines: string[] = [];

  const flush = () => {
    const text = currentLines.join('\n').trim();
    if (text.length >= MIN_SECTION_BODY_CHARS) {
      sections.push({ heading: currentHeading, slug: currentSlug, rawBody: text });
    }
  };

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      flush();
      currentHeading = h2[1].trim();
      currentSlug = slugify(currentHeading) || 'section';
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return sections;
}

interface H3Child {
  heading: string;
  slug: string;
  body: string;
}

/**
 * Walk an H2 body and pull out its H3 children. Returns:
 *   - `preamble`: text between the H2 heading and the first H3 (may be empty)
 *   - `children`: one entry per `### ` line, body trimmed
 * If there are no H3s, `children` is empty.
 */
function splitH2IntoH3s(rawBody: string): { preamble: string; children: H3Child[] } {
  const lines = rawBody.split('\n');
  const children: H3Child[] = [];
  const preambleLines: string[] = [];
  let inH3 = false;
  let currentHeading = '';
  let currentSlug = '';
  let currentLines: string[] = [];

  const flushH3 = () => {
    const text = currentLines.join('\n').trim();
    if (text.length === 0 && currentHeading.length === 0) return;
    children.push({ heading: currentHeading, slug: currentSlug || 'section', body: text });
  };

  for (const line of lines) {
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) {
      if (inH3) flushH3();
      inH3 = true;
      currentHeading = h3[1].trim();
      currentSlug = slugify(currentHeading) || 'section';
      currentLines = [];
    } else if (inH3) {
      currentLines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (inH3) flushH3();

  return {
    preamble: preambleLines.join('\n').trim(),
    children,
  };
}

/**
 * Split a markdown document into directive-sized sections.
 *
 * Default: one chunk per H2 (with pre-first-H2 text as an Overview chunk).
 *
 * An H2 is FURTHER split into per-H3 chunks when either
 *   - it has H3_SPLIT_MIN_CHILDREN (3) or more H3 kids, OR
 *   - its full body exceeds H3_SPLIT_BODY_CHARS (4000)
 * In that case the H2 produces zero rolled-up chunks and one chunk per H3
 * child instead. Any preamble before the first H3 is folded into the first
 * H3 chunk so we don't lose intro prose.
 *
 * Within-file slug collisions get a numeric suffix as before.
 */
function chunkMarkdown(md: string): DocSection[] {
  const raw = splitByH2(md);
  const sections: DocSection[] = [];

  for (const h2 of raw) {
    const { preamble, children } = splitH2IntoH3s(h2.rawBody);
    const overBodyThreshold = h2.rawBody.length > H3_SPLIT_BODY_CHARS;
    const enoughChildren = children.length >= H3_SPLIT_MIN_CHILDREN;
    const shouldSplit = children.length > 0 && (enoughChildren || overBodyThreshold);

    if (!shouldSplit) {
      // Keep as-is. Body still has the H3 lines verbatim — that's fine,
      // the chunk reads naturally.
      if (h2.rawBody.length >= MIN_SECTION_BODY_CHARS) {
        sections.push({ slug: h2.slug, heading: h2.heading, body: h2.rawBody });
      }
      continue;
    }

    // Split: each H3 becomes its own chunk. Fold preamble into the first
    // H3 body so any intro prose between the H2 line and the first H3
    // stays attached to the answer for "what's in §06".
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const body = i === 0 && preamble.length > 0
        ? `${preamble}\n\n${child.body}`.trim()
        : child.body.trim();
      if (body.length < MIN_SECTION_BODY_CHARS) continue;
      sections.push({
        slug: h2.slug,
        subSlug: child.slug,
        heading: `${h2.heading} — ${child.heading}`,
        body,
      });
    }
  }

  // De-dupe slug pairs within the same file. The composite key is
  // `<h2-slug>::<h3-slug>` or just `<h2-slug>` so an H2 chunk and a
  // (hypothetical) split-with-same-slug pair don't collide.
  const seen = new Map<string, number>();
  return sections.map((section) => {
    const key = section.subSlug ? `${section.slug}::${section.subSlug}` : section.slug;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 1) return section;
    return section.subSlug
      ? { ...section, subSlug: `${section.subSlug}-${count}` }
      : { ...section, slug: `${section.slug}-${count}` };
  });
}

function listSpecFiles(repoPath: string): string[] {
  const found = new Set<string>();

  for (const name of ROOT_SPEC_FILES) {
    const candidate = join(repoPath, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) found.add(candidate);
    } catch {
      // skip
    }
  }

  for (const subdir of SPEC_SUBDIRS) {
    const root = join(repoPath, subdir);
    try {
      if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    const stack: string[] = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: ReturnType<typeof readdirSync> = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        // Skip hidden and obvious noise dirs.
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          found.add(full);
        }
      }
    }
  }

  return [...found];
}

function directiveFilenameFor(id: string): string {
  // `:` is legal in macOS filenames but trips other tooling; flatten it.
  return `${id.replace(/:/g, '__')}.md`;
}

function deletePriorSpecDirectives(
  directivesDir: string,
  repoSlug: string,
  sqlite: ReturnType<typeof getSqlite> | null,
): number {
  const idPrefix = `${DIRECTIVE_ID_PREFIX}:${repoSlug}:`;
  let deleted = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(directivesDir);
  } catch {
    return 0;
  }
  const ftsDelete = sqlite
    ? (() => {
        try {
          return sqlite.prepare('DELETE FROM directives_fts WHERE directive_id = ?');
        } catch {
          return null;
        }
      })()
    : null;
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const path = join(directivesDir, name);
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch {
      continue;
    }
    const match = content.match(/^id:\s*(.+)$/m);
    if (!match) continue;
    const id = match[1].trim();
    if (id.startsWith(idPrefix)) {
      try {
        unlinkSync(path);
        deleted++;
        try { ftsDelete?.run(id); } catch { /* skip */ }
      } catch {
        // skip
      }
    }
  }
  return deleted;
}

/**
 * The repo slug embedded in a spec-ingest directive id, or null when the id
 * isn't a spec-ingest row. Ids are `spec-ingest:<slug>:<file>:<h2>[:<h3>]`, so
 * the slug is the first segment after the prefix. Lower-cased to match the
 * basename comparison `directiveAppliesToRepo()` uses.
 */
export function specIngestSlugFromId(id: string): string | null {
  const prefix = `${DIRECTIVE_ID_PREFIX}:`;
  if (!id.startsWith(prefix)) return null;
  const slug = id.slice(prefix.length).split(':')[0];
  return slug ? slug.toLowerCase() : null;
}

/**
 * Auto-heal a repo rename (#1228): purge spec-ingest directives whose slug is
 * claimed by NO registered repo. A rename (cortex-ide → o8) surfaces as a fresh
 * addRepo at the new path — it re-ingests under the new slug but leaves the old
 * one's rows behind. `directiveAppliesToRepo()` matches basename(repoPath), so
 * those stale rows apply to nothing AND still occupy the FTS top-N candidate
 * slots, starving live directives out of retrieval (the #1228 live-hit: 1,406
 * stale rows blanked the brain's own spec knowledge for a full day). They
 * regenerate from the repo's spec files, so purging is pure cleanup.
 *
 * Only the `spec-ingest:` prefix is touched — hand-authored `seed-*` directives
 * are never purged. A rename has no trustworthy old→new mapping (it's just a
 * new addRepo), so authored seeds stay with the manual migration script.
 *
 * SAFETY: returns immediately when `liveSlugs` is empty. A failed repo lookup
 * must NEVER be read as "every directive is orphaned" — that would wipe the
 * whole brain. `liveSlugs` is lower-cased internally so a mixed-case caller
 * can't cause a wrong purge.
 */
export function purgeOrphanedSpecDirectives(
  liveSlugs: Set<string>,
  opts?: { directivesDir?: string; sqlite?: ReturnType<typeof getSqlite> | null },
): { purged: number; slugs: string[] } {
  if (liveSlugs.size === 0) return { purged: 0, slugs: [] };
  const live = new Set([...liveSlugs].map((s) => s.toLowerCase()));

  const directivesDir = opts?.directivesDir ?? join(getDataDir(), 'directives');
  let entries: string[] = [];
  try {
    entries = readdirSync(directivesDir);
  } catch {
    return { purged: 0, slugs: [] };
  }

  const sqlite = opts?.sqlite !== undefined
    ? opts.sqlite
    : (() => { try { return getSqlite(); } catch { return null; } })();
  const ftsDelete = sqlite
    ? (() => {
        try { return sqlite.prepare('DELETE FROM directives_fts WHERE directive_id = ?'); } catch { return null; }
      })()
    : null;

  let purged = 0;
  const purgedSlugs = new Set<string>();
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const path = join(directivesDir, name);
    let content: string;
    try { content = readFileSync(path, 'utf-8'); } catch { continue; }
    const match = content.match(/^id:\s*(.+)$/m);
    if (!match) continue;
    const id = match[1].trim();
    const slug = specIngestSlugFromId(id);
    if (!slug || live.has(slug)) continue;
    try {
      unlinkSync(path);
      purged += 1;
      purgedSlugs.add(slug);
      try { ftsDelete?.run(id); } catch { /* skip */ }
    } catch {
      // skip — don't fail the sweep on one file
    }
  }

  if (purged > 0) {
    try { invalidateAnswerCache(); } catch { /* skip */ }
  }
  return { purged, slugs: [...purgedSlugs] };
}

function escapeYamlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').trim();
}

/**
 * Ingest a single repo's spec files into directives.
 *
 * @param repoPath  Absolute path to the repo root.
 * @param repoSlug  Short slug used in directive IDs. Defaults to basename(repoPath).
 *                  Pass the registry entry's `name` so directives line up with
 *                  what other surfaces (Recall Card, cortex_ask) expect.
 */
export async function ingestRepoSpecs(repoPath: string, repoSlug?: string): Promise<SpecIngestResult> {
  const slug = (repoSlug ?? basename(repoPath)).trim() || basename(repoPath);
  const dataDir = getDataDir();
  const directivesDir = join(dataDir, 'directives');
  mkdirSync(directivesDir, { recursive: true });

  // The FTS5 directives index won't pick new files up unless we hand each
  // one to refreshDirectiveFts — backfillDirectivesFts only runs on an empty
  // index. Grab the sqlite handle once and reuse it for every write.
  let sqlite: ReturnType<typeof getSqlite> | null = null;
  try {
    sqlite = getSqlite();
  } catch {
    sqlite = null;
  }

  const deletedStaleDirectives = deletePriorSpecDirectives(directivesDir, slug, sqlite);

  const specFiles = listSpecFiles(repoPath);
  let writtenDirectives = 0;
  const now = new Date().toISOString();

  for (const filePath of specFiles) {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const relPath = relative(repoPath, filePath);
    const fileSlug = slugify(relPath.replace(/\.md$/i, '')) || 'spec';

    // Inline `**[image: <caption>]**` after each markdown image so BM25
    // retrieval can match visual references (#1131). Cached by mtime+path
    // in ~/.o8/spec-image-captions.json; cache hits cost nothing.
    try {
      raw = await captionImagesInSpec(filePath, raw);
    } catch (err) {
      console.warn(`[spec-ingest] image captioning skipped for ${filePath}:`, err);
    }

    const sections = chunkMarkdown(raw);
    if (sections.length === 0) continue;

    for (const section of sections) {
      const id = section.subSlug
        ? `${DIRECTIVE_ID_PREFIX}:${slug}:${fileSlug}:${section.slug}:${section.subSlug}`
        : `${DIRECTIVE_ID_PREFIX}:${slug}:${fileSlug}:${section.slug}`;
      const rawTitle = `${slug}/${relPath} — ${section.heading}`;
      const title = rawTitle.length > MAX_FRONT_MATTER_TITLE_CHARS
        ? `${rawTitle.slice(0, MAX_FRONT_MATTER_TITLE_CHARS - 1)}…`
        : rawTitle;
      const escapedTitle = escapeYamlString(title);
      const escapedSlug = escapeYamlString(slug);
      // Cap body so a runaway README doesn't write a 200KB directive.
      const trimmedBody = section.body.length > MAX_DIRECTIVE_BODY_CHARS
        ? `${section.body.slice(0, MAX_DIRECTIVE_BODY_CHARS)}\n\n_[truncated — source has more]_`
        : section.body;

      const content = `---
id: ${id}
title: "${escapedTitle}"
scope: repo
repoName: "${escapedSlug}"
priority: 5
created: ${now}
updated: ${now}
---

# ${section.heading}

${trimmedBody}

_Source: ${slug}/${relPath} — auto-ingested from repo specs (spec-ingest)._
`;

      const outPath = join(directivesDir, directiveFilenameFor(id));
      try {
        writeFileSync(outPath, content, 'utf-8');
        writtenDirectives++;
        // Refresh FTS5 row immediately so cortex_ask sees this directive
        // without waiting for a boot-time backfill (which only runs on an
        // empty index — see v14-fts5-migration backfillDirectivesFts).
        if (sqlite) {
          try {
            refreshDirectiveFts(sqlite, directiveFilenameFor(id), content);
          } catch {
            // skip — FTS refresh failure shouldn't fail the ingest
          }
        }
      } catch {
        // skip — don't fail the whole ingest on one file
      }
    }
  }

  // Directives changed — cached Q&A answers may now cite stale content.
  // Eager invalidation is what lets the answer cache run a long (30min) TTL.
  if (writtenDirectives > 0 || deletedStaleDirectives > 0) {
    invalidateAnswerCache();
  }

  return {
    scannedFiles: specFiles.length,
    writtenDirectives,
    deletedStaleDirectives,
    files: specFiles.map((f) => relative(repoPath, f)),
  };
}
