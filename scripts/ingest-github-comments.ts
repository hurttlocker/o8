/**
 * One-shot ingestion runner for GitHub issue + PR review comments.
 *
 * Walks every repo in ~/.o8/repos.json, pulls comments via the GitHub App
 * installation, upserts into `github_comments`, lets the FTS5 triggers
 * keep `comments_fts` coherent.
 *
 * Usage:
 *   npx tsx scripts/ingest-github-comments.ts
 *
 * Re-run anytime — the cursor in `comments_sync` makes follow-up runs
 * incremental (only fetches comments updated since the last successful run).
 */

import { ingestAllRepoComments } from '@/lib/cortex/ingest/github-comments';

async function main() {
  const start = Date.now();
  const summary = await ingestAllRepoComments();
  const elapsed = Date.now() - start;

  console.log('');
  console.log('[ingest-github-comments] summary:');
  console.log(`  repos scanned : ${summary.reposScanned}`);
  console.log(`  repos skipped : ${summary.reposSkipped}`);
  console.log(`  issue comments: ${summary.totalIssueComments}`);
  console.log(`  pr comments   : ${summary.totalPrReviewComments}`);
  console.log(`  elapsed       : ${elapsed}ms`);
  console.log('');

  for (const repo of summary.perRepo) {
    console.log(
      `  ${repo.repoFullName.padEnd(40)} issue=${repo.issueCommentsIngested} pr=${repo.prReviewCommentsIngested}` +
        (repo.errors.length > 0 ? ` errors=${repo.errors.length}` : ''),
    );
    for (const error of repo.errors) {
      console.log(`    - ${error}`);
    }
  }
}

main().catch((error) => {
  console.error('[ingest-github-comments] FAIL', error);
  process.exit(1);
});
