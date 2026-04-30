#!/usr/bin/env node
/**
 * Re-anchor expectedCitations in tests/qa-eval/cases.json so the rowIds match
 * the format the Q&A composer actually emits.
 *
 * #915 path-to-70 phase 1.5.
 *
 * Two fixes:
 *
 * 1. The composer emits citations with rowId prefixed by kind:
 *      directive  → "directive-<bare-id>"
 *      outcome    → "outcome-<bare-id>"
 *      pr         → "pr-<pull_request_id>"
 *      issue      → "issue-<issue_id>"
 *      project    → "project-<bare-id>"
 *      project_repo → "project_repo-<repo_uuid>"
 *
 *    Before this script ran, cases.json had bare rowIds (e.g. "seed-cortex-ide-...")
 *    so citation_correctness was always ~0 even when the right row was cited.
 *
 * 2. Phase 1.3 (#948) deduped runtime directives that duplicated seeds via
 *    upsert-by-slug. Two legacy runtime IDs in cases.json no longer exist:
 *      d-1775763867817-183404ef  (was a runtime dupe of seed-cortex-ide-inline-styles-only)
 *      d-1775763668585-fba2ce0b  (was a runtime dupe of seed-global-typecheck-before-commit)
 *    Drop those — the seed citation already covers the same content.
 *
 * 3. Issue rowIds: the cases.json had GH issue NUMBERS (e.g. "915") but the
 *    retriever cites the integer issue_id from github_issues (e.g. "4353815519").
 *    Map by number → issue_id from the live DB.
 *
 * Usage:
 *   node scripts/qa-eval-rewrite-citations.mjs --dry-run
 *   node scripts/qa-eval-rewrite-citations.mjs --apply
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const APPLY = process.argv.includes('--apply');

// --- DB-backed lookups -------------------------------------------------------

const dbPath = path.join(
  process.env.O8_DATA_DIR || process.env.CORTEX_IDE_DATA_DIR || path.join(os.homedir(), '.o8'),
  'cortex-ide.db',
);
const db = new Database(dbPath, { readonly: true });

// number → issue_id, used for "issue" citations.
const issueNumberToId = new Map();
for (const row of db.prepare('SELECT number, issue_id FROM github_issues').all()) {
  issueNumberToId.set(String(row.number), String(row.issue_id));
}

// id set, used to drop dead outcome rowIds (we keep ones that exist).
const liveOutcomeIds = new Set();
for (const row of db.prepare('SELECT id FROM session_outcomes').all()) {
  liveOutcomeIds.add(row.id);
}

// id set, used for projects.
const liveProjectIds = new Set();
for (const row of db.prepare('SELECT id FROM projects').all()) {
  liveProjectIds.add(row.id);
}

// repo_id set, used for project_repos.
const liveProjectRepoIds = new Set();
for (const row of db.prepare('SELECT repo_id FROM project_repos').all()) {
  liveProjectRepoIds.add(row.repo_id);
}

// directive slug set from disk (~/.o8/directives/*.md).
const directivesDir = path.join(
  process.env.O8_DATA_DIR || process.env.CORTEX_IDE_DATA_DIR || path.join(os.homedir(), '.o8'),
  'directives',
);
const liveDirectiveIds = new Set(
  (await fs.readdir(directivesDir).catch(() => []))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, '')),
);

// IDs that were in cases.json but were deduped away.
const DEAD_DIRECTIVE_IDS = new Set([
  'd-1775763867817-183404ef',
  'd-1775763668585-fba2ce0b',
]);

// --- Citation rewrite --------------------------------------------------------

/**
 * Translate one expectedCitation entry into the kind-prefixed shape, dropping
 * any rowId that no longer resolves on the live DB.
 *
 * @returns the rewritten citation, or null if the row is dead and should be dropped.
 */
function rewriteCitation(cit, caseId) {
  const { kind, rowId } = cit;

  if (DEAD_DIRECTIVE_IDS.has(rowId)) {
    return null; // deduped away
  }

  let bare = rowId;
  // Strip prefix if already prefixed (idempotent).
  if (rowId.startsWith(`${kind}-`)) {
    bare = rowId.slice(kind.length + 1);
  }

  let resolved = bare;
  let alive = false;

  switch (kind) {
    case 'directive':
      alive = liveDirectiveIds.has(bare);
      break;
    case 'outcome':
      alive = liveOutcomeIds.has(bare);
      break;
    case 'project':
      alive = liveProjectIds.has(bare);
      break;
    case 'project_repo':
      alive = liveProjectRepoIds.has(bare);
      break;
    case 'issue': {
      // If `bare` is a GH issue NUMBER (small int), translate to issue_id.
      const numericProbe = issueNumberToId.get(bare);
      if (numericProbe) {
        resolved = numericProbe;
        alive = true;
      } else if (/^\d{8,}$/.test(bare)) {
        // Already an issue_id — accept if present.
        const found = db
          .prepare('SELECT 1 AS hit FROM github_issues WHERE issue_id = ?')
          .get(bare);
        alive = Boolean(found);
        resolved = bare;
      }
      break;
    }
    case 'pr': {
      // bare may be number or pull_request_id.
      const found = db
        .prepare('SELECT 1 AS hit FROM github_pull_requests WHERE pull_request_id = ? OR number = ?')
        .get(bare, Number(bare));
      alive = Boolean(found);
      resolved = bare;
      break;
    }
  }

  if (!alive) {
    process.stderr.write(
      `[rewrite] ${caseId}: drop ${kind}/${rowId} (not in live DB / disk)\n`,
    );
    return null;
  }

  return { kind, rowId: `${kind}-${resolved}` };
}

// --- Main --------------------------------------------------------------------

const casesPath = path.resolve(process.cwd(), 'tests/qa-eval/cases.json');
const raw = await fs.readFile(casesPath, 'utf-8');
const file = JSON.parse(raw);

let totalBefore = 0;
let totalAfter = 0;
let droppedCount = 0;
let prefixedCount = 0;

for (const c of file.cases) {
  totalBefore += c.expectedCitations.length;
  const next = [];
  for (const cit of c.expectedCitations) {
    const r = rewriteCitation(cit, c.id);
    if (r === null) {
      droppedCount += 1;
      continue;
    }
    if (r.rowId !== cit.rowId) prefixedCount += 1;
    next.push(r);
  }
  c.expectedCitations = next;
  totalAfter += next.length;
}

// Bump the comment + version-stamp to flag the rewrite.
file.$comment = (file.$comment ?? '') +
  ` Phase 1.5 (#915 path-to-70): expectedCitations rewritten so rowIds match the kind-prefixed format the composer emits (e.g. "directive-seed-cortex-ide-..."). Dead runtime IDs (d-17757638..., d-17757636...) deduped via #948 were dropped — the seed citation already covers the same content. Issue numbers translated to issue_ids per github_issues.issue_id.`;

process.stderr.write(
  `[rewrite] cases=${file.cases.length} citations: ${totalBefore} → ${totalAfter} (prefixed=${prefixedCount}, dropped=${droppedCount})\n`,
);

if (APPLY) {
  await fs.writeFile(casesPath, JSON.stringify(file, null, 2) + '\n', 'utf-8');
  process.stderr.write(`[rewrite] wrote ${casesPath}\n`);
} else {
  process.stderr.write(`[rewrite] DRY RUN — pass --apply to write.\n`);
}

db.close();
