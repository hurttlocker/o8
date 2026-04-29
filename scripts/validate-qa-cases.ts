#!/usr/bin/env tsx
/**
 * Validate tests/qa-eval/cases.json — epic #915 sub-issue 3 wave A.
 *
 * Checks:
 *   1. File parses as JSON
 *   2. Has version + cases[]
 *   3. Exactly 30 cases
 *   4. Exactly 5 cases per category across the 6 expected categories
 *   5. Every case has the required fields with the right types
 *   6. (warning, not failure) every expectedCitations[].rowId resolves against
 *      the live ~/.o8/cortex-ide.db. Fresh clones don't have rows yet, so we
 *      warn instead of fail — the runner is responsible for the runtime gate.
 *
 * Exit 0 when well-formed. Exit 1 on any structural failure.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

type Category = 'ownership' | 'decisions' | 'processes' | 'incidents' | 'specs' | 'cross-repo';

interface ExpectedCitation {
  kind: 'outcome' | 'directive' | 'pr' | 'issue' | 'project' | 'project_repo';
  rowId: string;
}

interface QaCase {
  id: string;
  category: Category;
  repoPath: string;
  question: string;
  expectedAnswer: string | null;
  expectedFacts: string[];
  expectedCitations: ExpectedCitation[];
  rubric: {
    factual_accuracy_threshold: number;
    citation_correctness_threshold: number;
    max_hallucinations: number;
  };
  knownGap?: string;
}

const EXPECTED_CATEGORIES: Category[] = [
  'ownership',
  'decisions',
  'processes',
  'incidents',
  'specs',
  'cross-repo',
];
const EXPECTED_CITATION_KINDS: ExpectedCitation['kind'][] = [
  'outcome',
  'directive',
  'pr',
  'issue',
  'project',
  'project_repo',
];
const EXPECTED_TOTAL = 30;
const EXPECTED_PER_CATEGORY = 5;

interface ValidationResult {
  errors: string[];
  warnings: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateCase(qaCase: unknown, idx: number): string[] {
  const errs: string[] = [];
  if (!isObject(qaCase)) {
    errs.push(`cases[${idx}] is not an object`);
    return errs;
  }
  const c = qaCase as Record<string, unknown>;

  if (typeof c.id !== 'string' || c.id.length === 0) {
    errs.push(`cases[${idx}].id missing or not a string`);
  }
  if (typeof c.category !== 'string' || !EXPECTED_CATEGORIES.includes(c.category as Category)) {
    errs.push(
      `cases[${idx}].category invalid — got ${JSON.stringify(c.category)}, expected one of ${EXPECTED_CATEGORIES.join('/')}`,
    );
  }
  if (typeof c.repoPath !== 'string' || c.repoPath.length === 0) {
    errs.push(`cases[${idx}].repoPath missing or not a string`);
  }
  if (typeof c.question !== 'string' || c.question.length === 0) {
    errs.push(`cases[${idx}].question missing or not a string`);
  }
  if (c.expectedAnswer !== null && typeof c.expectedAnswer !== 'string') {
    errs.push(`cases[${idx}].expectedAnswer must be string or null`);
  }
  if (!Array.isArray(c.expectedFacts)) {
    errs.push(`cases[${idx}].expectedFacts must be an array`);
  } else {
    for (let i = 0; i < c.expectedFacts.length; i++) {
      if (typeof c.expectedFacts[i] !== 'string') {
        errs.push(`cases[${idx}].expectedFacts[${i}] must be a string`);
      }
    }
  }
  if (!Array.isArray(c.expectedCitations)) {
    errs.push(`cases[${idx}].expectedCitations must be an array`);
  } else {
    for (let i = 0; i < c.expectedCitations.length; i++) {
      const cit = c.expectedCitations[i];
      if (!isObject(cit)) {
        errs.push(`cases[${idx}].expectedCitations[${i}] must be an object`);
        continue;
      }
      const k = cit as Record<string, unknown>;
      if (
        typeof k.kind !== 'string' ||
        !EXPECTED_CITATION_KINDS.includes(k.kind as ExpectedCitation['kind'])
      ) {
        errs.push(
          `cases[${idx}].expectedCitations[${i}].kind must be one of ${EXPECTED_CITATION_KINDS.join('/')}`,
        );
      }
      if (typeof k.rowId !== 'string' || k.rowId.length === 0) {
        errs.push(`cases[${idx}].expectedCitations[${i}].rowId must be a non-empty string`);
      }
    }
  }
  if (!isObject(c.rubric)) {
    errs.push(`cases[${idx}].rubric missing or not an object`);
  } else {
    const r = c.rubric as Record<string, unknown>;
    for (const key of [
      'factual_accuracy_threshold',
      'citation_correctness_threshold',
      'max_hallucinations',
    ]) {
      if (typeof r[key] !== 'number') {
        errs.push(`cases[${idx}].rubric.${key} must be a number`);
      }
    }
  }
  if (c.knownGap !== undefined && typeof c.knownGap !== 'string') {
    errs.push(`cases[${idx}].knownGap must be a string when present`);
  }
  return errs;
}

interface RowProbe {
  table: string;
  column: string;
}

const CITATION_PROBE: Record<ExpectedCitation['kind'], RowProbe | null> = {
  outcome: { table: 'session_outcomes', column: 'id' },
  directive: null, // directives live as files in ~/.o8/directives/, not the DB
  pr: { table: 'github_pull_requests', column: 'number' },
  issue: { table: 'github_issues', column: 'number' },
  project: { table: 'projects', column: 'id' },
  project_repo: { table: 'project_repos', column: 'repo_id' },
};

async function probeCitations(
  cases: QaCase[],
  warnings: string[],
): Promise<void> {
  const dataDir =
    process.env.O8_DATA_DIR ||
    process.env.CORTEX_IDE_DATA_DIR ||
    path.join(os.homedir(), '.o8');
  const dbPath = path.join(dataDir, 'cortex-ide.db');
  const directivesDir = path.join(dataDir, 'directives');

  let dbExists = false;
  try {
    await fs.access(dbPath);
    dbExists = true;
  } catch {
    warnings.push(
      `cortex-ide.db not found at ${dbPath} — citation rowId probe skipped (fresh clone is fine)`,
    );
  }

  let directiveFiles = new Set<string>();
  try {
    const files = await fs.readdir(directivesDir);
    directiveFiles = new Set(
      files.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')),
    );
  } catch {
    warnings.push(
      `directives dir not found at ${directivesDir} — directive citation probe skipped (fresh clone is fine)`,
    );
  }

  // Lazy-load better-sqlite3 only when we have a DB and at least one DB-backed citation.
  type DbHandle = { prepare(sql: string): { get(...args: unknown[]): unknown } } | null;
  let db: DbHandle = null;
  if (dbExists) {
    try {
      // Dynamic import keeps this script runnable in environments where
      // better-sqlite3 wasn't compiled (CI for the marketing repo, etc.).
      const mod = (await import('better-sqlite3')) as unknown as {
        default: new (p: string, opts: { readonly: boolean }) => DbHandle;
      };
      const Ctor = mod.default;
      db = new Ctor(dbPath, { readonly: true });
    } catch (err) {
      warnings.push(
        `could not open ${dbPath} for read — citation rowId probe skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const qaCase of cases) {
    for (const cit of qaCase.expectedCitations) {
      if (cit.kind === 'directive') {
        if (directiveFiles.size === 0) continue;
        if (!directiveFiles.has(cit.rowId)) {
          warnings.push(
            `case ${qaCase.id}: expectedCitations rowId '${cit.rowId}' (kind=directive) not found in ${directivesDir}`,
          );
        }
        continue;
      }
      const probe = CITATION_PROBE[cit.kind];
      if (!probe || !db) continue;
      try {
        const row = db
          .prepare(`SELECT 1 AS hit FROM ${probe.table} WHERE ${probe.column} = ? LIMIT 1`)
          .get(cit.rowId);
        if (!row) {
          warnings.push(
            `case ${qaCase.id}: expectedCitations rowId '${cit.rowId}' (kind=${cit.kind}) not found in ${probe.table}.${probe.column}`,
          );
        }
      } catch (err) {
        warnings.push(
          `case ${qaCase.id}: probe failed for rowId '${cit.rowId}' (kind=${cit.kind}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

async function validate(): Promise<ValidationResult> {
  const result: ValidationResult = { errors: [], warnings: [] };
  const casesPath = path.resolve(process.cwd(), 'tests/qa-eval/cases.json');

  let raw: string;
  try {
    raw = await fs.readFile(casesPath, 'utf-8');
  } catch (err) {
    result.errors.push(
      `cannot read ${casesPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    result.errors.push(
      `cases.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  if (!isObject(parsed)) {
    result.errors.push('cases.json root must be an object');
    return result;
  }
  const file = parsed as Record<string, unknown>;
  if (typeof file.version !== 'number') {
    result.errors.push('cases.json must declare a numeric "version"');
  }
  if (!Array.isArray(file.cases)) {
    result.errors.push('cases.json must include a "cases" array');
    return result;
  }

  const cases = file.cases as unknown[];
  if (cases.length !== EXPECTED_TOTAL) {
    result.errors.push(`expected ${EXPECTED_TOTAL} cases, got ${cases.length}`);
  }

  const seenIds = new Set<string>();
  const perCategoryCount: Record<string, number> = {};

  for (let i = 0; i < cases.length; i++) {
    const errs = validateCase(cases[i], i);
    for (const e of errs) result.errors.push(e);

    if (isObject(cases[i])) {
      const c = cases[i] as Record<string, unknown>;
      if (typeof c.id === 'string') {
        if (seenIds.has(c.id)) {
          result.errors.push(`duplicate case id ${c.id}`);
        } else {
          seenIds.add(c.id);
        }
      }
      if (typeof c.category === 'string') {
        perCategoryCount[c.category] = (perCategoryCount[c.category] ?? 0) + 1;
      }
    }
  }

  for (const cat of EXPECTED_CATEGORIES) {
    const n = perCategoryCount[cat] ?? 0;
    if (n !== EXPECTED_PER_CATEGORY) {
      result.errors.push(`category '${cat}' has ${n} cases, expected ${EXPECTED_PER_CATEGORY}`);
    }
  }
  for (const cat of Object.keys(perCategoryCount)) {
    if (!EXPECTED_CATEGORIES.includes(cat as Category)) {
      result.errors.push(`unknown category '${cat}' present in cases.json`);
    }
  }

  // Only do the live-DB probe when structural validation already passed —
  // probing a malformed file just produces noisy warnings.
  if (result.errors.length === 0) {
    await probeCitations(cases as QaCase[], result.warnings);
  }

  return result;
}

async function main(): Promise<void> {
  const result = await validate();

  for (const w of result.warnings) {
    console.warn(`[validate-qa-cases] warn: ${w}`);
  }
  if (result.errors.length === 0) {
    console.log(
      `[validate-qa-cases] OK — ${EXPECTED_TOTAL} cases, ${EXPECTED_PER_CATEGORY}/category across ${EXPECTED_CATEGORIES.length} categories`,
    );
    process.exitCode = 0;
    return;
  }
  for (const e of result.errors) {
    console.error(`[validate-qa-cases] error: ${e}`);
  }
  process.exitCode = 1;
}

void main().catch((err) => {
  console.error('[validate-qa-cases] unexpected failure:', err);
  process.exitCode = 1;
});
