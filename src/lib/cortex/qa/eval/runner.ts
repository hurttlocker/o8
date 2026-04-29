/**
 * Cortex Q&A eval runner — epic #915 sub-issue 3 wave A.
 *
 * Loads tests/qa-eval/cases.json, calls a placeholder askCortex() for each
 * case, scores with the Sonnet-as-judge stub, aggregates per category, prints
 * a summary, and exits 0 if every category scores >= 70% factual_accuracy.
 *
 * Wave A scope:
 *   - askCortex() is intentionally not implemented yet — it throws and the
 *     runner records the throw as a row with score 0. This is by design: the
 *     `npm run eval:qa` command should fail loudly until Wave B wires up the
 *     retrieval layer + judge call.
 *   - The qa_eval_runs table from sub-issue 1 isn't required to be present.
 *     If getDb() returns null or the table doesn't exist, the runner skips the
 *     persistence step with a warning rather than crashing — the eval still
 *     prints a summary so a fresh-clone CI can see the regression categories.
 *
 * Wave B will:
 *   - Replace askCortex() with the real three-retriever fanout (sql.ts +
 *     fts.ts + graph.ts) + Flash classifier + Sonnet streaming compose.
 *   - Replace judgeStub() with a real Sonnet call.
 *   - Drop the qa_eval_runs table via schema v14 and persist every run.
 *   - Add the contradiction detector pass.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  judgeStub,
  renderJudgePrompt,
  type ExpectedCitation,
  type JudgeInput,
  type JudgeResult,
} from '../../../../../tests/qa-eval/judge';

// ── Shapes that mirror cases.json ──────────────────────────────────────────

type Category = 'ownership' | 'decisions' | 'processes' | 'incidents' | 'specs' | 'cross-repo';

interface Rubric {
  factual_accuracy_threshold: number;
  citation_correctness_threshold: number;
  max_hallucinations: number;
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

// ── askCortex placeholder — Wave B replaces this ───────────────────────────

export interface AskCortexResult {
  answer: string;
  citations: ExpectedCitation[];
}

/**
 * Wave A stub. Throws on every call so the runner reports the unimplemented
 * state without inventing fake answers.
 *
 * Wave B replaces this with the real retrieval+compose pipeline imported from
 * src/lib/cortex/qa/{sql,fts,graph,classifier,composer}.ts.
 */
async function askCortex(_question: string, _repoPath: string): Promise<AskCortexResult> {
  throw new Error(
    'askCortex not yet implemented — ships in epic #915 sub-issue 2 (Wave B). Eval runner intentionally fails until then.',
  );
}

// ── Persistence (best-effort) ──────────────────────────────────────────────

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

/**
 * Persist a single run row. Sub-issue 1 ships qa_eval_runs as part of
 * schema v14 — until then the call is a no-op.
 *
 * The Wave B implementation should INSERT into qa_eval_runs(
 *   question_id, expected, actual, score (json blob), run_at
 * ).
 */
async function persistRun(_row: RunRow): Promise<void> {
  // Wave A: intentional no-op. Schema v14 lands with sub-issue 1.
  return;
}

// ── Aggregation ────────────────────────────────────────────────────────────

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
];

const CATEGORY_THRESHOLD = 0.7; // 70% factual_accuracy floor per category

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

// ── Main entrypoint ────────────────────────────────────────────────────────

export async function runEval(): Promise<RunSummary> {
  const casesPath = path.resolve(process.cwd(), 'tests/qa-eval/cases.json');
  const raw = await fs.readFile(casesPath, 'utf-8');
  const file = JSON.parse(raw) as CasesFile;

  const perCategory: Record<Category, CategoryAgg> = {
    ownership: emptyAgg(),
    decisions: emptyAgg(),
    processes: emptyAgg(),
    incidents: emptyAgg(),
    specs: emptyAgg(),
    'cross-repo': emptyAgg(),
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
      actual = await askCortex(qaCase.question, qaCase.repoPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      agg.failures.push({ id: qaCase.id, reason: `askCortex threw: ${message}` });
      // Persist the throw as a zero-score run so trends stay visible.
      const stubResult: JudgeResult = {
        factual_accuracy: 0,
        citation_correctness: 0,
        hallucination_count: 0,
        notes: `askCortex threw: ${message}`,
      };
      const runAt = new Date().toISOString();
      await persistRun({
        questionId: qaCase.id,
        category: qaCase.category,
        expected: qaCase.expectedAnswer,
        actual: '(error) askCortex threw',
        factualAccuracy: stubResult.factual_accuracy,
        citationCorrectness: stubResult.citation_correctness,
        hallucinationCount: stubResult.hallucination_count,
        notes: stubResult.notes,
        runAt,
      });
      // Count toward scored so the threshold gate fails loudly.
      agg.scored += 1;
      totalScored += 1;
      continue;
    }

    const judgeInput: JudgeInput = {
      question: qaCase.question,
      expectedAnswer: qaCase.expectedAnswer,
      expectedFacts: qaCase.expectedFacts,
      expectedCitations: qaCase.expectedCitations,
      actualAnswer: actual.answer,
      actualCitations: actual.citations,
    };
    // Render the prompt (unused in Wave A but exercises the template path).
    void renderJudgePrompt(judgeInput);

    const score = await judgeStub(judgeInput);

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

  // Per-category gate: factual_accuracy mean must be >= CATEGORY_THRESHOLD.
  let passed = true;
  for (const cat of CATEGORIES) {
    const agg = perCategory[cat];
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
  const summary = await runEval();
  printSummary(summary);
  process.exitCode = summary.passed ? 0 : 1;
}

// Only run when executed directly (npm run eval:qa). Importing this file from
// a smoke test should not trigger the runner.
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
