#!/usr/bin/env node
/**
 * One-shot directive dedupe (#915 path-to-70 phase 1.3).
 *
 * Removes legacy `d-<timestamp>-<hash>.md` directive files that duplicate the
 * canonical `seed-*.md` rules. Created when the now-deleted `directives-store.ts`
 * (commit e04b1c17) was wired up via the old DirectivesView UI; the files
 * lingered on disk after the UI was de-scoped.
 *
 * Why this matters: the FTS5 retriever's RRF picks one or the other dupe
 * non-deterministically, so the Q&A judge sees the wrong-flavor citation
 * and dings citation_correctness.
 *
 * Strategy: enumerate the known dupe pairs explicitly. Topic-based matching
 * (not exact body match — the d-* paraphrases differ from seed-*) is brittle
 * to compute automatically; an explicit map is reviewable and safe.
 *
 * Default mode prints what would be deleted. Pass `--apply` to actually delete.
 *
 *   node scripts/dedupe-directives.mjs            # dry-run
 *   node scripts/dedupe-directives.mjs --apply    # do it
 */

import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dataDir = process.env.O8_DATA_DIR
  || process.env.CORTEX_IDE_DATA_DIR
  || join(homedir(), '.o8');
const directivesDir = join(dataDir, 'directives');

// Explicit dupe map — runtime id → seed id it duplicates.
// Anything not in this map is left alone (including unique runtime directives
// like `d-1775763923771-01f6ae06` for mission-control's Drizzle ORM rule).
const DUPE_PAIRS = [
  {
    runtimeId: 'd-1775680178529-f26225f2',
    runtimeTitle: 'Never use CSS classes',
    seedId: 'seed-cortex-ide-inline-styles-only',
  },
  {
    runtimeId: 'd-1775680185317-d1fbfc0c',
    runtimeTitle: 'Always typecheck before commit',
    seedId: 'seed-global-typecheck-before-commit',
  },
  {
    runtimeId: 'd-1775763668585-fba2ce0b',
    runtimeTitle: 'Critical: never skip typecheck',
    seedId: 'seed-global-typecheck-before-commit',
  },
  {
    runtimeId: 'd-1775763867817-183404ef',
    runtimeTitle: 'Inline styles only',
    seedId: 'seed-cortex-ide-inline-styles-only',
  },
  {
    runtimeId: 'd-1775763908394-17f99541',
    runtimeTitle: '800-line file ceiling',
    seedId: 'seed-cortex-ide-800-line-ceiling',
  },
];

function readFrontMatter(raw) {
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---')) return {};
  const afterFirst = text.slice(3).trimStart();
  const closing = afterFirst.search(/^---\s*$/m);
  if (closing < 0) return {};
  const front = afterFirst.slice(0, closing);
  const meta = {};
  for (const line of front.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key) meta[key] = value;
  }
  return meta;
}

async function main() {
  const apply = process.argv.includes('--apply');

  if (!existsSync(directivesDir)) {
    console.error(`[dedupe-directives] No directives dir at ${directivesDir}`);
    process.exit(1);
  }

  const files = readdirSync(directivesDir).filter((f) => f.endsWith('.md'));
  console.log(`[dedupe-directives] Scanning ${directivesDir}`);
  console.log(`[dedupe-directives] Found ${files.length} markdown files\n`);

  // Build a map of present ids
  const presentIds = new Map();
  for (const f of files) {
    try {
      const raw = readFileSync(join(directivesDir, f), 'utf-8');
      const meta = readFrontMatter(raw);
      const id = meta.id || f.replace(/\.md$/i, '');
      presentIds.set(id, { file: f, title: meta.title || '(no title)' });
    } catch (err) {
      console.warn(`[dedupe-directives] Could not read ${f}:`, err.message);
    }
  }

  // Resolve dupe pairs
  const toDelete = [];
  const skipped = [];
  for (const pair of DUPE_PAIRS) {
    const runtime = presentIds.get(pair.runtimeId);
    const seed = presentIds.get(pair.seedId);
    if (!runtime) {
      skipped.push(`${pair.runtimeId} — runtime row already absent`);
      continue;
    }
    if (!seed) {
      skipped.push(`${pair.runtimeId} — seed counterpart ${pair.seedId} missing; keeping runtime row to avoid data loss`);
      continue;
    }
    // Defensive: confirm the runtime row title matches what we expect.
    if (runtime.title !== pair.runtimeTitle) {
      skipped.push(
        `${pair.runtimeId} — title changed (expected "${pair.runtimeTitle}", got "${runtime.title}"); skip to be safe`,
      );
      continue;
    }
    toDelete.push({ ...pair, runtimeFile: runtime.file });
  }

  console.log(`[dedupe-directives] Plan: delete ${toDelete.length} runtime dupe(s)\n`);
  for (const entry of toDelete) {
    console.log(`  DELETE  ${entry.runtimeFile}`);
    console.log(`          id=${entry.runtimeId}`);
    console.log(`          title="${entry.runtimeTitle}"`);
    console.log(`          dupe of seed=${entry.seedId}\n`);
  }
  if (skipped.length > 0) {
    console.log(`[dedupe-directives] Skipped:`);
    for (const reason of skipped) {
      console.log(`  - ${reason}`);
    }
    console.log();
  }

  if (!apply) {
    console.log('[dedupe-directives] DRY RUN — pass --apply to actually delete.');
    console.log('[dedupe-directives] FTS5 rows in directives_fts will be removed on next boot when');
    console.log('                    backfillDirectivesFts() detects the missing files.');
    return;
  }

  // Apply.
  let deletedFiles = 0;
  for (const entry of toDelete) {
    const filePath = join(directivesDir, entry.runtimeFile);
    try {
      unlinkSync(filePath);
      deletedFiles += 1;
      console.log(`[dedupe-directives] deleted ${entry.runtimeFile}`);
    } catch (err) {
      console.warn(`[dedupe-directives] FAILED to delete ${entry.runtimeFile}:`, err.message);
    }
  }

  // Update directives_fts directly so the running app doesn't have to wait
  // for a boot cycle. We do this through better-sqlite3 — same dependency
  // o8 itself uses, so we don't add anything new.
  let ftsRowsRemoved = 0;
  let ftsTotalAfter = null;
  try {
    const dbPath = join(dataDir, 'cortex-ide.db');
    if (existsSync(dbPath)) {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbPath);
      try {
        const del = db.prepare('DELETE FROM directives_fts WHERE directive_id = ?');
        for (const entry of toDelete) {
          const result = del.run(entry.runtimeId);
          ftsRowsRemoved += result.changes ?? 0;
        }
        const row = db.prepare('SELECT COUNT(*) as c FROM directives_fts').get();
        ftsTotalAfter = row.c;
      } finally {
        db.close();
      }
    } else {
      console.warn(`[dedupe-directives] No DB at ${dbPath} — skip FTS sync`);
    }
  } catch (err) {
    console.warn('[dedupe-directives] FTS sync failed:', err.message);
  }

  console.log();
  console.log(`[dedupe-directives] DONE`);
  console.log(`  Files deleted:   ${deletedFiles}`);
  console.log(`  FTS rows pruned: ${ftsRowsRemoved}`);
  if (ftsTotalAfter != null) {
    console.log(`  directives_fts row count: ${ftsTotalAfter}`);
  }
}

main().catch((err) => {
  console.error('[dedupe-directives] fatal:', err);
  process.exit(1);
});
