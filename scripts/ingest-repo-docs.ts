/**
 * Standalone ingestion script for repo markdown (epic #915 phase 1.7 #3).
 *
 *   npx tsx scripts/ingest-repo-docs.ts
 *
 * Walks every repo in `~/.o8/repos.json` and upserts CLAUDE.md / README /
 * AGENTS.md / THEME.md / docs/**\/*.md (including docs/design/DESIGN.md) /
 * `*.md` at the repo root
 * into the `docs` table (schema v16). The trigger keeps `docs_fts` in sync.
 *
 * Pretty-prints a per-repo + per-kind summary. Exit code 1 on any repo error
 * so a future cron wrapper can detect partial failures.
 */

import { ingestAllRepos } from '@/lib/cortex/ingest/repo-docs';

function main() {
  const start = Date.now();
  const summary = ingestAllRepos();
  const elapsed = Date.now() - start;

  console.log('');
  console.log('[ingest-docs] per-repo:');
  let anyErrors = false;
  for (const repo of summary.repos) {
    const errFlag = repo.errors.length > 0 ? ' ERR' : '';
    console.log(
      `  ${repo.repoName.padEnd(20)} scanned=${String(repo.scanned).padStart(3)} ` +
        `upserted=${String(repo.upserted).padStart(3)} unchanged=${String(repo.unchanged).padStart(3)} ` +
        `skipped=${String(repo.skipped).padStart(3)}${errFlag}`,
    );
    if (repo.errors.length > 0) {
      anyErrors = true;
      for (const e of repo.errors) {
        console.log(`         - ${e}`);
      }
    }
  }

  console.log('');
  console.log('[ingest-docs] per-kind in docs table:');
  for (const kind of Object.keys(summary.byKind) as Array<keyof typeof summary.byKind>) {
    console.log(`  ${kind.padEnd(12)} ${summary.byKind[kind]}`);
  }

  console.log('');
  console.log(
    `[ingest-docs] done — ${summary.totalUpserted} upserted, ${summary.totalUnchanged} unchanged, ` +
      `${elapsed}ms`,
  );

  process.exitCode = anyErrors ? 1 : 0;
}

main();
