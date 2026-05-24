/**
 * spec-ingest — auto-ingest a repo's authoritative markdown specs as
 * `scope: repo` directives so the Engineering Brain (#915) has substrate to
 * answer design / convention / "how do we do X here" questions.
 *
 * Scope per #1114:
 *   - Root files: README.md, CLAUDE.md, AGENTS.md, DESIGN.md, THEME.md
 *   - Directories: docs/** (recursive, *.md only)
 *
 * Chunking:
 *   One directive per H2 section. The text BEFORE the first H2 becomes an
 *   "Overview" chunk. Sections shorter than 40 chars are skipped (likely
 *   stubs or empty headers).
 *
 * Idempotency:
 *   All directive IDs begin with `spec-ingest:<repoSlug>:`. Re-running
 *   delete-then-writes so re-ingest on the same repo doesn't duplicate.
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

const ROOT_SPEC_FILES = ['README.md', 'CLAUDE.md', 'AGENTS.md', 'DESIGN.md', 'THEME.md'] as const;
const SPEC_SUBDIRS = ['docs'] as const;
const MIN_SECTION_BODY_CHARS = 40;
const MAX_FRONT_MATTER_TITLE_CHARS = 160;
const MAX_DIRECTIVE_BODY_CHARS = 16_000;
const DIRECTIVE_ID_PREFIX = 'spec-ingest';

export interface SpecIngestResult {
  scannedFiles: number;
  writtenDirectives: number;
  deletedStaleDirectives: number;
  files: string[];
}

interface H2Section {
  heading: string;
  slug: string;
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

/**
 * Split a markdown document into one section per top-level H2 heading.
 * Content before the first H2 becomes an Overview section.
 */
function chunkByH2(md: string): H2Section[] {
  const body = stripFrontMatter(md);
  const lines = body.split('\n');
  const sections: H2Section[] = [];

  let currentHeading = 'Overview';
  let currentSlug = 'overview';
  let currentLines: string[] = [];

  const flush = () => {
    const text = currentLines.join('\n').trim();
    if (text.length >= MIN_SECTION_BODY_CHARS) {
      sections.push({ heading: currentHeading, slug: currentSlug, body: text });
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

  // De-dupe slugs within the same file (rare but possible — e.g. multiple
  // "## Why" sections). Append a numeric suffix.
  const seen = new Map<string, number>();
  return sections.map((section) => {
    const count = (seen.get(section.slug) ?? 0) + 1;
    seen.set(section.slug, count);
    return count === 1 ? section : { ...section, slug: `${section.slug}-${count}` };
  });
}

function listSpecFiles(repoPath: string): string[] {
  const found: string[] = [];

  for (const name of ROOT_SPEC_FILES) {
    const candidate = join(repoPath, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) found.push(candidate);
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
          found.push(full);
        }
      }
    }
  }

  return found;
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

    const sections = chunkByH2(raw);
    if (sections.length === 0) continue;

    for (const section of sections) {
      const id = `${DIRECTIVE_ID_PREFIX}:${slug}:${fileSlug}:${section.slug}`;
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

  return {
    scannedFiles: specFiles.length,
    writtenDirectives,
    deletedStaleDirectives,
    files: specFiles.map((f) => relative(repoPath, f)),
  };
}
