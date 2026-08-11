/**
 * Migrate brain directives after a repo rename (slug change).
 *
 * A repo rename orphans every directive stamped with the old slug:
 * directiveAppliesToRepo() matches repoName against basename(repoPath), so
 * stale-slug directives are filtered from retrieval — AND they still occupy
 * the FTS top-N candidate slots, starving live directives out of the results
 * (live-hit 2026-06-11: cortex-ide → o8 rename silently emptied the brain's
 * o8 spec knowledge).
 *
 * Usage: NODE_OPTIONS='--conditions=react-server' npx tsx scripts/migrate-directive-repo-slug.ts <oldSlug> <repoPath>
 *   e.g. ... migrate-directive-repo-slug.ts cortex-ide /Users/me/o8
 *
 * CAVEAT — out-of-process cache staleness: this script runs in its own
 * process, so the RUNNING app's in-memory answer caches (exact + semantic,
 * 30-min TTL) are NOT invalidated. Questions asked before the re-ingest can
 * keep replaying their stale answers until the TTL expires or the app
 * restarts. Re-verify with `bypassCache` (answer route body / SSE ?force=1).
 *
 * Does three things:
 *   1. seed-* directives with repoName: <oldSlug> → restamped to the new slug
 *      (frontmatter rewrite + FTS row refresh).
 *   2. spec-ingest:<oldSlug>:* directives deleted (file + FTS row) — they're
 *      regenerated under the new slug by step 3.
 *   3. ingestRepoSpecs(repoPath) re-ingests the repo's specs fresh.
 */

import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getDataDir } from '../src/lib/data-dir-migration';
import { getSqlite } from '../src/lib/db';
import { refreshDirectiveFts } from '../src/lib/db/v14-fts5-migration';
import { ingestRepoSpecs } from '../src/lib/cortex/spec-ingest';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function restampDirectiveRepoName(content: string, oldSlug: string, newSlug: string): string | null {
  const repoNameRe = new RegExp(`^(repoName:\\s*)(["']?)${escapeRegExp(oldSlug)}\\2\\s*$`, 'm');
  if (!repoNameRe.test(content)) return null;
  return content.replace(repoNameRe, (_match, prefix: string, quote: string) => (
    `${prefix}${quote}${newSlug}${quote}`
  ));
}

async function main() {
  const oldSlug = process.argv[2];
  const repoPath = process.argv[3];
  if (!oldSlug || !repoPath) {
    console.error('usage: migrate-directive-repo-slug.ts <oldSlug> <repoPath>');
    process.exit(1);
  }
  const newSlug = basename(repoPath);
  const directivesDir = join(getDataDir(), 'directives');
  const sqlite = getSqlite();

  let restamped = 0;
  let purged = 0;

  for (const name of readdirSync(directivesDir)) {
    if (!name.endsWith('.md')) continue;
    const path = join(directivesDir, name);
    const content = readFileSync(path, 'utf-8');

    // 1. Restamp seeds (and any hand-authored directive) bound to the old slug.
    const next = restampDirectiveRepoName(content, oldSlug, newSlug);
    if (next) {
      writeFileSync(path, next, 'utf-8');
      refreshDirectiveFts(sqlite, name, next);
      restamped += 1;
      continue;
    }

    // 2. Purge stale spec-ingest rows for the old slug (file + FTS).
    const idMatch = content.match(/^id:\s*(.+)$/m);
    const id = idMatch?.[1]?.trim() ?? '';
    if (id.startsWith(`spec-ingest:${oldSlug}:`)) {
      try { sqlite.prepare('DELETE FROM directives_fts WHERE directive_id = ?').run(id); } catch {}
      unlinkSync(path);
      purged += 1;
    }
  }

  // 3. Fresh ingest under the new slug.
  const result = await ingestRepoSpecs(repoPath);
  console.log(`restamped=${restamped} purged=${purged} reingested=${result.writtenDirectives} scanned=${result.scannedFiles}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
