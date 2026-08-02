/**
 * #938 three-way memory-substrate runner.
 *
 * For each test case in tests/qa-eval/cases.json, runs FOUR conditions and
 * compares them with the same Sonnet-via-OpenRouter judge held constant.
 *
 *   full  — production askCortex() pipeline: classify → retrieveAll →
 *           unionMerge → composeClassA/B. This is the Cortex v2 substrate
 *           in its real form (directives + facts + ledger + symbol graph).
 *   grep  — naive grep over CLAUDE.md (project + global) + repos.json,
 *           top-15 lines by keyword hits → same composer. The hostile-read
 *           dismissal of the memory layer as "just markdown."
 *   strongGrep — realistic repo-wide ripgrep over top matching files,
 *           bounded matched-line context windows → same composer.
 *   blind — empty row set → same composer. The floor: what does the LLM
 *           know from training data alone?
 *
 * Classifier runs ONCE per case so all four conditions hit the same
 * composer (composeClassA vs composeClassB). The only varied input is the
 * TypedRow set the composer sees.
 *
 * Output:
 *   - tests/qa-eval/three-way-results-<timestamp>.json (raw)
 *   - Per-condition × per-category factual_accuracy table on stdout
 *   - Per-case deltas between full, grep, strongGrep, and blind
 *
 * Run: O8_EVAL_MODE=1 OPENROUTER_API_KEY=... npx tsx \
 *      src/lib/cortex/qa/eval/three-way-runner.ts
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { askCortex } from '@/lib/cortex/qa/ask';
import { classifyQuestion } from '@/lib/cortex/qa/classifier';
import { composeClassA, composeClassB, type SseEmit } from '@/lib/cortex/qa/composer';
import { callSonnet } from '@/lib/cortex/qa/llm/sonnet-adapter';
import { STRICT_JSON_SYSTEM_PROMPTS_V1 } from '@/lib/prompts/v1';
import type { Citation, TypedRow } from '@/lib/cortex/qa/types';

import { buildBlindTopRows, buildGrepTopRows, buildStrongGrepTopRows } from './baselines';
import { resolveEvalRepoPath } from './repo-path';
import { renderJudgePrompt } from '../../../../../tests/qa-eval/judge';

// ── Case types (mirror runner.ts) ─────────────────────────────────────────────

type Category =
  | 'ownership'
  | 'decisions'
  | 'processes'
  | 'incidents'
  | 'specs'
  | 'cross-repo'
  | 'literal-lookup';

interface ExpectedCitation { kind: string; rowId: string }

interface Rubric {
  factual_accuracy_threshold: number;
  citation_correctness_threshold: number;
  max_hallucinations: number;
}

interface QaCase {
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

interface CasesFile { version: number; cases: QaCase[] }

// ── Judge (inlined from runner.ts) ────────────────────────────────────────────

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

function parseJudgeJson(raw: string): JudgeResult | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Partial<JudgeResult>;
    const factual_accuracy = typeof parsed.factual_accuracy === 'number'
      ? Math.max(0, Math.min(1, parsed.factual_accuracy)) : null;
    const citation_correctness = typeof parsed.citation_correctness === 'number'
      ? Math.max(0, Math.min(1, parsed.citation_correctness)) : null;
    const hallucination_count = typeof parsed.hallucination_count === 'number'
      ? Math.max(0, Math.floor(parsed.hallucination_count)) : null;
    const notes = typeof parsed.notes === 'string' ? parsed.notes : '';
    if (factual_accuracy === null || citation_correctness === null || hallucination_count === null) {
      return null;
    }
    return { factual_accuracy, citation_correctness, hallucination_count, notes };
  } catch {
    return null;
  }
}

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
    return JUDGE_FAILED;
  } catch {
    return JUDGE_FAILED;
  }
}

// ── Condition runners ─────────────────────────────────────────────────────────

interface ComposeOutput {
  answer: string;
  citations: ExpectedCitation[];
}

async function runCompose(
  cls: 'A' | 'B',
  question: string,
  repoPath: string | undefined,
  topRows: TypedRow[],
): Promise<ComposeOutput> {
  let answer = '';
  const citations: ExpectedCitation[] = [];
  const emit: SseEmit = (name, payload) => {
    if (name === 'token') {
      answer += (payload as { text: string }).text ?? '';
    } else if (name === 'citation') {
      const p = payload as { kind: Citation['kind']; rowId: string };
      citations.push({ kind: p.kind, rowId: p.rowId });
    }
  };
  if (cls === 'A') {
    await composeClassA(question, repoPath, topRows, emit);
  } else {
    await composeClassB(question, repoPath, topRows, emit);
  }
  return { answer: answer.trim(), citations };
}

/**
 * Full condition — production askCortex() (reuses cache-bypass + classifier
 * + retrieveAll + unionMerge + composer in one call).
 */
async function runConditionFull(qc: QaCase): Promise<ComposeOutput> {
  const result = await askCortex(qc.question, resolveEvalRepoPath(qc.repoPath).repoPath, { bypassCache: true });
  return {
    answer: result.answer,
    citations: result.citations.map((c) => ({ kind: c.kind, rowId: c.rowId })),
  };
}

/**
 * Grep / blind condition — share the same composer with the full condition
 * by classifying first (so composer choice is consistent per case) and
 * then composing with the alternate row set.
 */
async function runConditionAlt(
  qc: QaCase,
  cls: 'A' | 'B',
  topRows: TypedRow[],
): Promise<ComposeOutput> {
  return runCompose(cls, qc.question, resolveEvalRepoPath(qc.repoPath).repoPath, topRows);
}

// ── Aggregation ───────────────────────────────────────────────────────────────

interface ConditionAgg {
  scored: number;
  factualSum: number;
  citationSum: number;
  hallucinationSum: number;
}

interface CategoryAgg {
  total: number;
  full: ConditionAgg;
  grep: ConditionAgg;
  strongGrep: ConditionAgg;
  blind: ConditionAgg;
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

function emptyConditionAgg(): ConditionAgg {
  return { scored: 0, factualSum: 0, citationSum: 0, hallucinationSum: 0 };
}

function emptyCategoryAgg(): CategoryAgg {
  return {
    total: 0,
    full: emptyConditionAgg(),
    grep: emptyConditionAgg(),
    strongGrep: emptyConditionAgg(),
    blind: emptyConditionAgg(),
  };
}

function addToAgg(agg: ConditionAgg, score: JudgeResult): void {
  agg.scored += 1;
  agg.factualSum += score.factual_accuracy;
  agg.citationSum += score.citation_correctness;
  agg.hallucinationSum += score.hallucination_count;
}

function formatPct(x: number): string { return `${(x * 100).toFixed(1)}%`; }

// ── Main ──────────────────────────────────────────────────────────────────────

interface PerCaseResult {
  id: string;
  category: Category;
  question: string;
  classification: 'A' | 'B';
  full: { answer: string; citations: ExpectedCitation[]; score: JudgeResult; topRowsCount: number };
  grep: { answer: string; citations: ExpectedCitation[]; score: JudgeResult; topRowsCount: number };
  strongGrep: { answer: string; citations: ExpectedCitation[]; score: JudgeResult; topRowsCount: number };
  blind: { answer: string; citations: ExpectedCitation[]; score: JudgeResult; topRowsCount: number };
  deltas: {
    full_vs_grep: number;
    full_vs_strongGrep: number;
    strongGrep_vs_grep: number;
    full_vs_blind: number;
    grep_vs_blind: number;
  };
}

async function main(): Promise<void> {
  process.env.O8_EVAL_MODE = process.env.O8_EVAL_MODE ?? '1';

  const casesPath = path.resolve(process.cwd(), 'tests/qa-eval/cases.json');
  const raw = await fs.readFile(casesPath, 'utf-8');
  const fileRaw = JSON.parse(raw) as CasesFile;
  const limit = process.env.THREE_WAY_LIMIT ? Number(process.env.THREE_WAY_LIMIT) : fileRaw.cases.length;
  const file: CasesFile = { ...fileRaw, cases: fileRaw.cases.slice(0, limit) };

  console.log(`[938] running ${file.cases.length} cases × 4 conditions = ${file.cases.length * 4} generations`);
  console.log(`[938] eval mode: ${process.env.O8_EVAL_MODE} (Sonnet-via-OpenRouter for compose + judge)`);

  const perCategory: Record<Category, CategoryAgg> = {
    ownership: emptyCategoryAgg(),
    decisions: emptyCategoryAgg(),
    processes: emptyCategoryAgg(),
    incidents: emptyCategoryAgg(),
    specs: emptyCategoryAgg(),
    'cross-repo': emptyCategoryAgg(),
    'literal-lookup': emptyCategoryAgg(),
  };

  const perCase: PerCaseResult[] = [];
  const t0 = Date.now();

  for (let idx = 0; idx < file.cases.length; idx++) {
    const qc = file.cases[idx];
    const tCase0 = Date.now();
    console.log(`\n[938] case ${idx + 1}/${file.cases.length}: ${qc.id} (${qc.category})`);
    console.log(`        Q: ${qc.question.slice(0, 80)}${qc.question.length > 80 ? '...' : ''}`);

    perCategory[qc.category].total += 1;

    // Classify once so all 4 conditions use the same composer.
    let classification: 'A' | 'B';
    try {
      const c = await classifyQuestion(qc.question);
      classification = c.class;
    } catch (err) {
      console.warn(`        classify failed (${err instanceof Error ? err.message : err}) — defaulting to B`);
      classification = 'B';
    }
    console.log(`        class: ${classification}`);

    // ── Condition: full ──
    let fullOut: ComposeOutput;
    try {
      fullOut = await runConditionFull(qc);
    } catch (err) {
      console.warn(`        full threw: ${err instanceof Error ? err.message : err}`);
      fullOut = { answer: '(error)', citations: [] };
    }

    // ── Condition: grep ──
    let grepRows: TypedRow[] = [];
    let grepOut: ComposeOutput;
    try {
      grepRows = await buildGrepTopRows(qc.question, resolveEvalRepoPath(qc.repoPath).repoPath, 15);
      grepOut = await runConditionAlt(qc, classification, grepRows);
    } catch (err) {
      console.warn(`        grep threw: ${err instanceof Error ? err.message : err}`);
      grepOut = { answer: '(error)', citations: [] };
    }

    // ── Condition: strongGrep ──
    let strongGrepRows: TypedRow[] = [];
    let strongGrepOut: ComposeOutput;
    try {
      strongGrepRows = await buildStrongGrepTopRows(qc.question, resolveEvalRepoPath(qc.repoPath).repoPath);
      strongGrepOut = await runConditionAlt(qc, classification, strongGrepRows);
    } catch (err) {
      console.warn(`        strongGrep threw: ${err instanceof Error ? err.message : err}`);
      strongGrepOut = { answer: '(error)', citations: [] };
    }

    // ── Condition: blind ──
    let blindOut: ComposeOutput;
    try {
      blindOut = await runConditionAlt(qc, classification, buildBlindTopRows());
    } catch (err) {
      console.warn(`        blind threw: ${err instanceof Error ? err.message : err}`);
      blindOut = { answer: '(error)', citations: [] };
    }

    // ── Judge all four ──
    const judgeInput = (out: ComposeOutput) => ({
      question: qc.question,
      expectedAnswer: qc.expectedAnswer,
      expectedFacts: qc.expectedFacts,
      expectedCitations: qc.expectedCitations,
      actualAnswer: out.answer,
      actualCitations: out.citations,
    });
    const [fullScore, grepScore, strongGrepScore, blindScore] = await Promise.all([
      realJudge(judgeInput(fullOut)),
      realJudge(judgeInput(grepOut)),
      realJudge(judgeInput(strongGrepOut)),
      realJudge(judgeInput(blindOut)),
    ]);

    addToAgg(perCategory[qc.category].full, fullScore);
    addToAgg(perCategory[qc.category].grep, grepScore);
    addToAgg(perCategory[qc.category].strongGrep, strongGrepScore);
    addToAgg(perCategory[qc.category].blind, blindScore);

    const deltas = {
      full_vs_grep: fullScore.factual_accuracy - grepScore.factual_accuracy,
      full_vs_strongGrep: fullScore.factual_accuracy - strongGrepScore.factual_accuracy,
      strongGrep_vs_grep: strongGrepScore.factual_accuracy - grepScore.factual_accuracy,
      full_vs_blind: fullScore.factual_accuracy - blindScore.factual_accuracy,
      grep_vs_blind: grepScore.factual_accuracy - blindScore.factual_accuracy,
    };

    perCase.push({
      id: qc.id,
      category: qc.category,
      question: qc.question,
      classification,
      full: { answer: fullOut.answer, citations: fullOut.citations, score: fullScore, topRowsCount: -1 },
      grep: { answer: grepOut.answer, citations: grepOut.citations, score: grepScore, topRowsCount: grepRows.length },
      strongGrep: { answer: strongGrepOut.answer, citations: strongGrepOut.citations, score: strongGrepScore, topRowsCount: strongGrepRows.length },
      blind: { answer: blindOut.answer, citations: blindOut.citations, score: blindScore, topRowsCount: 0 },
      deltas,
    });

    const dt = Date.now() - tCase0;
    console.log(`        full: ${formatPct(fullScore.factual_accuracy)} | grep: ${formatPct(grepScore.factual_accuracy)} | strongGrep: ${formatPct(strongGrepScore.factual_accuracy)} | blind: ${formatPct(blindScore.factual_accuracy)}  (Δfull-strongGrep=${deltas.full_vs_strongGrep >= 0 ? '+' : ''}${(deltas.full_vs_strongGrep * 100).toFixed(0)}pp, ${(dt / 1000).toFixed(1)}s)`);
  }

  const totalDt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[938] completed ${file.cases.length} cases in ${totalDt}s`);

  // ── Print summary tables ──
  console.log('\n[938] PER-CATEGORY × PER-CONDITION factual_accuracy:');
  console.log('  category      total  | full         grep        strongGrep  blind       | Δfull-strong  Δfull-grep');
  console.log('  ' + '─'.repeat(112));
  const overallFull = { sum: 0, n: 0 };
  const overallGrep = { sum: 0, n: 0 };
  const overallStrongGrep = { sum: 0, n: 0 };
  const overallBlind = { sum: 0, n: 0 };
  for (const cat of CATEGORIES) {
    const agg = perCategory[cat];
    if (agg.total === 0) continue;
    const fullMean = agg.full.scored > 0 ? agg.full.factualSum / agg.full.scored : 0;
    const grepMean = agg.grep.scored > 0 ? agg.grep.factualSum / agg.grep.scored : 0;
    const strongGrepMean = agg.strongGrep.scored > 0 ? agg.strongGrep.factualSum / agg.strongGrep.scored : 0;
    const blindMean = agg.blind.scored > 0 ? agg.blind.factualSum / agg.blind.scored : 0;
    overallFull.sum += agg.full.factualSum; overallFull.n += agg.full.scored;
    overallGrep.sum += agg.grep.factualSum; overallGrep.n += agg.grep.scored;
    overallStrongGrep.sum += agg.strongGrep.factualSum; overallStrongGrep.n += agg.strongGrep.scored;
    overallBlind.sum += agg.blind.factualSum; overallBlind.n += agg.blind.scored;
    const dfsg = fullMean - strongGrepMean;
    const dfg = fullMean - grepMean;
    console.log(
      `  ${cat.padEnd(13)} ${String(agg.total).padStart(3)}    | ${formatPct(fullMean).padEnd(11)} ${formatPct(grepMean).padEnd(11)} ${formatPct(strongGrepMean).padEnd(11)} ${formatPct(blindMean).padEnd(11)} | ${(dfsg >= 0 ? '+' : '') + (dfsg * 100).toFixed(1).padStart(4)}pp       ${(dfg >= 0 ? '+' : '') + (dfg * 100).toFixed(1).padStart(4)}pp`
    );
  }
  const ofMean = overallFull.n > 0 ? overallFull.sum / overallFull.n : 0;
  const ogMean = overallGrep.n > 0 ? overallGrep.sum / overallGrep.n : 0;
  const osgMean = overallStrongGrep.n > 0 ? overallStrongGrep.sum / overallStrongGrep.n : 0;
  const obMean = overallBlind.n > 0 ? overallBlind.sum / overallBlind.n : 0;
  console.log('  ' + '─'.repeat(112));
  console.log(
    `  OVERALL       ${String(file.cases.length).padStart(3)}    | ${formatPct(ofMean).padEnd(11)} ${formatPct(ogMean).padEnd(11)} ${formatPct(osgMean).padEnd(11)} ${formatPct(obMean).padEnd(11)} | ${((ofMean - osgMean) >= 0 ? '+' : '') + ((ofMean - osgMean) * 100).toFixed(1).padStart(4)}pp       ${((ofMean - ogMean) >= 0 ? '+' : '') + ((ofMean - ogMean) * 100).toFixed(1).padStart(4)}pp`
  );

  // ── Persist raw ──
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.resolve(process.cwd(), `tests/qa-eval/three-way-results-${ts}.json`);
  await fs.writeFile(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalCases: file.cases.length,
    durationS: Number(totalDt),
    summary: {
      perCategory,
      overall: {
        full: ofMean,
        grep: ogMean,
        strongGrep: osgMean,
        blind: obMean,
        delta_full_vs_grep: ofMean - ogMean,
        delta_full_vs_strongGrep: ofMean - osgMean,
        delta_full_vs_blind: ofMean - obMean,
      },
    },
    perCase,
  }, null, 2));
  console.log(`\n[938] wrote raw results to ${outPath}`);
}

void main().catch((err) => {
  console.error('[938] unexpected failure:', err);
  process.exitCode = 1;
});
