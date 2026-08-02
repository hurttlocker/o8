/**
 * Cortex Q&A eval runner — epic #915 sub-issue 3 wave A (updated by sub-2).
 *
 * Wave B changes (this file, sub-issue 2):
 *   - askCortex() is now the real pipeline imported from
 *     src/lib/cortex/qa/ask.ts (Flash classifier + retrievers + Sonnet compose).
 *   - persistRun() is a best-effort SQLite write into qa_eval_runs (schema v14).
 *
 * Wave A contract (preserved):
 *   - Loads tests/qa-eval/cases.json
 *   - Scores with judgeStub()
 *   - Aggregates per category and exits 0 when all categories >= 70%
 *   - Persistence skipped gracefully if schema not migrated yet
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { askCortex } from '@/lib/cortex/qa/ask';
import { callSonnet } from '@/lib/cortex/qa/llm/sonnet-adapter';
import { STRICT_JSON_SYSTEM_PROMPTS_V1 } from '@/lib/prompts/v1';
import { renderJudgePrompt } from '../../../../../tests/qa-eval/judge';

// ── Types ──────────────────────────────────────────────────────────────────────

export type Category =
  | 'ownership'
  | 'decisions'
  | 'processes'
  | 'incidents'
  | 'specs'
  | 'cross-repo'
  | 'literal-lookup';

interface Rubric {
  factual_accuracy_threshold: number;
  citation_correctness_threshold: number;
  max_hallucinations: number;
}

export interface ExpectedCitation {
  kind: string;
  rowId: string;
}

export interface QaCase {
  id: string;
  category: Category;
  repoPath: string;
  question: string;
  expectedAnswer: string | null;
  expectedFacts: string[];
  expectedCitations: ExpectedCitation[];
  rubric: Rubric;
  knownGap?: string;
}

interface CasesFile {
  $comment?: string;
  version: number;
  generatedAt?: string;
  cases: QaCase[];
}

export interface AskCortexResult {
  answer: string;
  citations: ExpectedCitation[];
}

// ── Real Sonnet judge (via CLI > API > Flash) ─────────────────────────────────

interface JudgeResult {
  factual_accuracy: number;
  citation_correctness: number;
  hallucination_count: number;
  notes: string;
}

const JUDGE_FAILED: JudgeResult = {
  factual_accuracy: 0,
  citation_correctness: 0,
  hallucination_count: 0,
  notes: 'judge-failed',
};

/** Parse a JSON judge response from raw LLM text (may include markdown fences). */
function parseJudgeJson(raw: string): JudgeResult | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Partial<JudgeResult>;
    const factual_accuracy = typeof parsed.factual_accuracy === 'number' ? Math.max(0, Math.min(1, parsed.factual_accuracy)) : null;
    const citation_correctness = typeof parsed.citation_correctness === 'number' ? Math.max(0, Math.min(1, parsed.citation_correctness)) : null;
    const hallucination_count = typeof parsed.hallucination_count === 'number' ? Math.max(0, Math.floor(parsed.hallucination_count)) : null;
    const notes = typeof parsed.notes === 'string' ? parsed.notes : '';
    if (factual_accuracy === null || citation_correctness === null || hallucination_count === null) return null;
    return { factual_accuracy, citation_correctness, hallucination_count, notes };
  } catch {
    return null;
  }
}

/** Call Sonnet as judge. Provider resolved via CLI > API > Flash. */
async function realJudge(input: {
  question: string;
  expectedAnswer: string | null;
  expectedFacts: string[];
  expectedCitations: ExpectedCitation[];
  actualAnswer: string;
  actualCitations: ExpectedCitation[];
}): Promise<JudgeResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prompt = renderJudgePrompt(input as any);

  try {
    const result = await callSonnet({
      system: STRICT_JSON_SYSTEM_PROMPTS_V1.evaluator,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    });
    const parsed = parseJudgeJson(result.text);
    if (parsed) return parsed;
    console.warn('[qa-eval] Judge returned unparseable JSON — using JUDGE_FAILED');
    return JUDGE_FAILED;
  } catch (err) {
    console.warn('[qa-eval] realJudge threw:', err instanceof Error ? err.message : err);
    return JUDGE_FAILED;
  }
}

// ── Persistence (best-effort) ──────────────────────────────────────────────────

interface RunRow {
  questionId: string;
  category: Category;
  expected: string | null;
  actual: string;
  factualAccuracy: number;
  citationCorrectness: number;
  hallucinationCount: number;
  notes: string;
  runAt: string;
}

async function persistRun(row: RunRow): Promise<void> {
  try {
    // Dynamic import so fresh-clone CI doesn't crash on missing DB.
    const { getSqlite } = await import('@/lib/db');
    const db = getSqlite();
    // Schema: id(TEXT PK), question_id, category, expected_answer, actual_answer,
    //         citations_json, factual_accuracy, citation_correctness,
    //         hallucination_count, run_at(INTEGER).
    // `id` uses questionId + runAt so each eval run per question overwrites cleanly.
    const id = `${row.questionId}::${row.runAt}`;
    db.prepare(
      `INSERT OR REPLACE INTO qa_eval_runs
         (id, question_id, category, expected_answer, actual_answer,
          factual_accuracy, citation_correctness, hallucination_count, run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      row.questionId,
      row.category,
      row.expected ?? '',
      row.actual,
      row.factualAccuracy,
      row.citationCorrectness,
      row.hallucinationCount,
      new Date(row.runAt).getTime(),
    );
  } catch {
    // Table may not exist yet (schema v14 not migrated). Skip silently.
  }
}

// ── Aggregation ────────────────────────────────────────────────────────────────

interface CategoryAgg {
  total: number;
  scored: number;
  knownGaps: number;
  factualAccuracySum: number;
  citationCorrectnessSum: number;
  hallucinationCountSum: number;
  failures: Array<{ id: string; reason: string }>;
}

interface RunSummary {
  passed: boolean;
  perCategory: Record<Category, CategoryAgg>;
  overall: {
    cases: number;
    knownGaps: number;
    avgFactualAccuracy: number;
    avgCitationCorrectness: number;
    totalHallucinations: number;
  };
}

const CATEGORIES: Category[] = [
  'ownership',
  'decisions',
  'processes',
  'incidents',
  'specs',
  'cross-repo',
  'literal-lookup',
];

const CATEGORY_THRESHOLD = 0.7;

function emptyAgg(): CategoryAgg {
  return {
    total: 0,
    scored: 0,
    knownGaps: 0,
    factualAccuracySum: 0,
    citationCorrectnessSum: 0,
    hallucinationCountSum: 0,
    failures: [],
  };
}

// ── Main entrypoint ────────────────────────────────────────────────────────────

/**
 * Cases carry a placeholder repo path so no operator's home directory ships in
 * the public repo. Resolve it to a real checkout at run time, or the eval asks
 * every condition about a repository that does not exist and scores near zero
 * across the board — which reads as a catastrophic regression rather than a
 * broken harness (2026-08-02).
 */
async function resolveEvalRepoPath(declared: string): Promise<string> {
  const fromEnv = process.env.O8_EVAL_REPO_PATH?.trim();
  const candidates = [fromEnv, declared].filter((v): v is string => Boolean(v));
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(path.join(candidate, '.git'));
      if (stat) return candidate;
    } catch {
      // try the next candidate
    }
  }
  const registryPath = path.join(os.homedir(), '.o8', 'repos.json');
  try {
    const registry = JSON.parse(await fs.readFile(registryPath, 'utf-8')) as {
      repos?: Array<{ localPath?: string }>;
    };
    const first = registry.repos?.find((r) => typeof r.localPath === 'string' && r.localPath);
    if (first?.localPath) return first.localPath;
  } catch {
    // fall through to the declared path
  }
  return declared;
}

export async function runEval(): Promise<RunSummary> {
  const casesPath = path.resolve(process.cwd(), 'tests/qa-eval/cases.json');
  const raw = await fs.readFile(casesPath, 'utf-8');
  const file = JSON.parse(raw) as CasesFile;

  const declaredPath = file.cases[0]?.repoPath ?? '';
  const evalRepoPath = await resolveEvalRepoPath(declaredPath);
  if (evalRepoPath !== declaredPath) {
    console.warn(`[qa-eval] cases declare repoPath ${declaredPath}; running against ${evalRepoPath}`);
  }

  const perCategory: Record<Category, CategoryAgg> = {
    ownership: emptyAgg(),
    decisions: emptyAgg(),
    processes: emptyAgg(),
    incidents: emptyAgg(),
    specs: emptyAgg(),
    'cross-repo': emptyAgg(),
    'literal-lookup': emptyAgg(),
  };

  let totalKnownGaps = 0;
  let totalScored = 0;
  let factualAccuracySum = 0;
  let citationCorrectnessSum = 0;
  let totalHallucinations = 0;

  for (const qaCase of file.cases) {
    const agg = perCategory[qaCase.category];
    if (!agg) {
      console.warn(`[qa-eval] unknown category ${qaCase.category} on case ${qaCase.id} — skipped`);
      continue;
    }
    agg.total += 1;

    let actual: AskCortexResult;
    try {
      const result = await askCortex(qaCase.question, evalRepoPath, { bypassCache: true });
      actual = {
        answer: result.answer,
        citations: result.citations.map((c) => ({
          kind: c.kind,
          rowId: c.rowId,
        })),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      agg.failures.push({ id: qaCase.id, reason: `askCortex threw: ${message}` });
      const runAt = new Date().toISOString();
      await persistRun({
        questionId: qaCase.id,
        category: qaCase.category,
        expected: qaCase.expectedAnswer,
        actual: '(error) askCortex threw',
        factualAccuracy: 0,
        citationCorrectness: 0,
        hallucinationCount: 0,
        notes: `askCortex threw: ${message}`,
        runAt,
      });
      agg.scored += 1;
      totalScored += 1;
      continue;
    }

    const score = await realJudge({
      question: qaCase.question,
      expectedAnswer: qaCase.expectedAnswer,
      expectedFacts: qaCase.expectedFacts,
      expectedCitations: qaCase.expectedCitations,
      actualAnswer: actual.answer,
      actualCitations: actual.citations,
    });

    if (qaCase.knownGap) {
      agg.knownGaps += 1;
      totalKnownGaps += 1;
    }

    agg.scored += 1;
    agg.factualAccuracySum += score.factual_accuracy;
    agg.citationCorrectnessSum += score.citation_correctness;
    agg.hallucinationCountSum += score.hallucination_count;

    totalScored += 1;
    factualAccuracySum += score.factual_accuracy;
    citationCorrectnessSum += score.citation_correctness;
    totalHallucinations += score.hallucination_count;

    if (score.factual_accuracy < qaCase.rubric.factual_accuracy_threshold) {
      agg.failures.push({
        id: qaCase.id,
        reason: `factual_accuracy=${score.factual_accuracy.toFixed(2)} below threshold ${qaCase.rubric.factual_accuracy_threshold}`,
      });
    }

    await persistRun({
      questionId: qaCase.id,
      category: qaCase.category,
      expected: qaCase.expectedAnswer,
      actual: actual.answer,
      factualAccuracy: score.factual_accuracy,
      citationCorrectness: score.citation_correctness,
      hallucinationCount: score.hallucination_count,
      notes: score.notes,
      runAt: new Date().toISOString(),
    });
  }

  let passed = true;
  for (const cat of CATEGORIES) {
    const agg = perCategory[cat];
    if (agg.total === 0 && cat === 'literal-lookup') {
      continue;
    }
    if (agg.scored === 0) {
      passed = false;
      continue;
    }
    const mean = agg.factualAccuracySum / agg.scored;
    if (mean < CATEGORY_THRESHOLD) {
      passed = false;
    }
  }

  return {
    passed,
    perCategory,
    overall: {
      cases: file.cases.length,
      knownGaps: totalKnownGaps,
      avgFactualAccuracy: totalScored > 0 ? factualAccuracySum / totalScored : 0,
      avgCitationCorrectness: totalScored > 0 ? citationCorrectnessSum / totalScored : 0,
      totalHallucinations,
    },
  };
}

function formatPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function printSummary(summary: RunSummary): void {
  console.log('');
  console.log('[qa-eval] per-category factual_accuracy (threshold = 70%)');
  for (const cat of CATEGORIES) {
    const agg = summary.perCategory[cat];
    if (agg.total === 0 && cat === 'literal-lookup') continue;
    const mean = agg.scored > 0 ? agg.factualAccuracySum / agg.scored : 0;
    const flag = mean >= CATEGORY_THRESHOLD ? 'PASS' : 'FAIL';
    console.log(
      `  ${flag}  ${cat.padEnd(11)}  ${formatPct(mean)}  (scored=${agg.scored}/${agg.total}, gaps=${agg.knownGaps}, hallucinations=${agg.hallucinationCountSum})`,
    );
    if (agg.failures.length > 0) {
      for (const f of agg.failures) {
        console.log(`         - ${f.id}: ${f.reason}`);
      }
    }
  }
  console.log('');
  console.log(
    `[qa-eval] overall: cases=${summary.overall.cases} known-gaps=${summary.overall.knownGaps} ` +
      `avg_factual=${formatPct(summary.overall.avgFactualAccuracy)} ` +
      `avg_citation=${formatPct(summary.overall.avgCitationCorrectness)} ` +
      `hallucinations=${summary.overall.totalHallucinations}`,
  );
  console.log(`[qa-eval] result: ${summary.passed ? 'PASS' : 'FAIL'}`);
}

async function main(): Promise<void> {
  // Skip the 14-16s CLI bootstrap on every case during eval. The system-under-test
  // routes through OpenRouter (~1-6s) instead. The judge below keeps using
  // Sonnet CLI for scoring consistency across runs. Set explicitly here so
  // `npm run eval:qa` always benefits without requiring extra env in package.json.
  process.env.O8_EVAL_MODE = process.env.O8_EVAL_MODE ?? '1';

  const summary = await runEval();
  printSummary(summary);
  process.exitCode = summary.passed ? 0 : 1;
}

const runDirectly = (() => {
  if (typeof process === 'undefined' || !process.argv || process.argv.length < 2) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  return entry.endsWith('runner.ts') || entry.endsWith('runner.js') || entry.endsWith('runner.mjs');
})();

if (runDirectly) {
  void main().catch((err) => {
    console.error('[qa-eval] unexpected failure:', err);
    process.exitCode = 1;
  });
}
