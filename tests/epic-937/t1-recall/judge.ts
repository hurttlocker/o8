/**
 * t1-recall judge — scores each of the 3 path outputs per question on 3 axes
 * (factual_accuracy / citation_correctness / specificity) using Sonnet 4.6
 * via OpenRouter.
 *
 * Reads:  data/runs.json
 * Writes: data/scores.json
 *
 * Methodology:
 *   - One judge call per question (10 total). The judge scores all 3 paths
 *     simultaneously to keep the rubric consistent within a question.
 *   - Path labels are anonymized (path-A/B/C) before showing the judge, with
 *     per-question shuffled mapping, to avoid any prior bias toward "Brain"
 *     vs "grep" vs "long-context."
 *   - Each axis returns 0-1 (continuous). Specificity rewards concrete values
 *     (numbers, names, paths) verbatim from the reference answer.
 *
 * Pass bar (locked in REPORT.md): Brain wins ≥2 of 3 axes on ≥7 of 10 questions
 * vs BOTH baselines.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { callOpenRouter } from '@/lib/cortex/qa/llm/openrouter-adapter';

// ── Config ───────────────────────────────────────────────────────────────────

const T1_DATA = '/Users/marquisehurtt/o8-validation/tests/epic-937/t1-recall/data';
const RUNS_PATH = path.join(T1_DATA, 'runs.json');
const SCORES_PATH = path.join(T1_DATA, 'scores.json');

const SONNET_MODEL = 'anthropic/claude-sonnet-4-6';

// ── Types ────────────────────────────────────────────────────────────────────

interface PathResult {
  text: string;
  durationMs: number;
  meta?: Record<string, unknown>;
  error?: string;
}

interface RunRow {
  caseId: string;
  category: string;
  favoredPath: string;
  question: string;
  referenceAnswer: string;
  brain: PathResult;
  grep: PathResult;
  longCtx: PathResult;
}

interface AxisScores {
  factual_accuracy: number;
  citation_correctness: number;
  specificity: number;
  notes: string;
}

interface CaseScores {
  caseId: string;
  category: string;
  favoredPath: string;
  question: string;
  referenceAnswer: string;
  paths: {
    brain: AxisScores;
    grep: AxisScores;
    longCtx: AxisScores;
  };
}

// ── Judge prompt ─────────────────────────────────────────────────────────────

function buildJudgePrompt(
  question: string,
  referenceAnswer: string,
  // Anonymized labels — judge sees A/B/C, we map back after.
  answerA: string,
  answerB: string,
  answerC: string,
): string {
  return `You are a strict, deterministic engineering-Q&A judge. You will score three candidate answers against a reference answer on three axes.

Question: ${question}

Reference answer (ground truth):
${referenceAnswer}

Candidate A:
${answerA || '(empty)'}

Candidate B:
${answerB || '(empty)'}

Candidate C:
${answerC || '(empty)'}

Score each candidate INDEPENDENTLY against the reference answer. Do NOT compare candidates to each other. Each axis is a continuous score from 0.0 to 1.0.

Axes:
- factual_accuracy: Does the candidate state the same facts as the reference answer? Reward partial overlap. Ignore minor phrasing differences. Penalize hedging ("I don't have that information") if the reference DOES have the information. Score 0.0 if the candidate states a contradicting wrong fact.
- citation_correctness: Did the candidate cite a relevant source (file path, line, PR number, commit, or row handle)? 1.0 if it cites the same source(s) as the reference. 0.5 for a relevant but different source. 0.0 for no citations or irrelevant citations.
- specificity: Did the candidate include the concrete value asked for (a number, a name, a path, a percentage)? 1.0 if every concrete value in the reference appears in the candidate verbatim or with the same numeric/textual content. 0.5 if it has the right shape but generalizes. 0.0 if it gives no concrete values when the reference does.

Return STRICTLY this JSON object, no prose, no markdown fences:
{
  "A": {"factual_accuracy": <0-1>, "citation_correctness": <0-1>, "specificity": <0-1>, "notes": "<one sentence>"},
  "B": {"factual_accuracy": <0-1>, "citation_correctness": <0-1>, "specificity": <0-1>, "notes": "<one sentence>"},
  "C": {"factual_accuracy": <0-1>, "citation_correctness": <0-1>, "specificity": <0-1>, "notes": "<one sentence>"}
}`;
}

function shufflePaths(): { order: ('brain' | 'grep' | 'longCtx')[]; mapping: Record<'A' | 'B' | 'C', 'brain' | 'grep' | 'longCtx'> } {
  const paths: ('brain' | 'grep' | 'longCtx')[] = ['brain', 'grep', 'longCtx'];
  // Fisher-Yates shuffle
  for (let i = paths.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [paths[i], paths[j]] = [paths[j], paths[i]];
  }
  return {
    order: paths,
    mapping: { A: paths[0], B: paths[1], C: paths[2] },
  };
}

function parseJudgeResponse(text: string): { A: AxisScores; B: AxisScores; C: AxisScores } {
  // Strip code fences if present
  const cleaned = text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  const parsed = JSON.parse(cleaned) as { A: AxisScores; B: AxisScores; C: AxisScores };
  // Defensive: clamp to [0,1]
  for (const key of ['A', 'B', 'C'] as const) {
    const s = parsed[key];
    s.factual_accuracy = Math.max(0, Math.min(1, Number(s.factual_accuracy)));
    s.citation_correctness = Math.max(0, Math.min(1, Number(s.citation_correctness)));
    s.specificity = Math.max(0, Math.min(1, Number(s.specificity)));
  }
  return parsed;
}

// ── Judge a single case ──────────────────────────────────────────────────────

async function judgeCase(row: RunRow): Promise<CaseScores> {
  const { mapping } = shufflePaths();
  const answers: Record<'A' | 'B' | 'C', string> = {
    A: row[mapping.A].text,
    B: row[mapping.B].text,
    C: row[mapping.C].text,
  };
  const prompt = buildJudgePrompt(
    row.question,
    row.referenceAnswer,
    answers.A,
    answers.B,
    answers.C,
  );

  const text = await callOpenRouter(prompt, {
    model: SONNET_MODEL,
    timeoutMs: 60_000,
  });
  const parsed = parseJudgeResponse(text);

  // Map A/B/C back to brain/grep/longCtx
  const paths = {
    brain: parsed[invMapping(mapping, 'brain')],
    grep: parsed[invMapping(mapping, 'grep')],
    longCtx: parsed[invMapping(mapping, 'longCtx')],
  };

  return {
    caseId: row.caseId,
    category: row.category,
    favoredPath: row.favoredPath,
    question: row.question,
    referenceAnswer: row.referenceAnswer,
    paths,
  };
}

function invMapping(
  mapping: Record<'A' | 'B' | 'C', 'brain' | 'grep' | 'longCtx'>,
  pathName: 'brain' | 'grep' | 'longCtx',
): 'A' | 'B' | 'C' {
  for (const k of ['A', 'B', 'C'] as const) {
    if (mapping[k] === pathName) return k;
  }
  throw new Error(`unmapped path: ${pathName}`);
}

// ── Aggregation ──────────────────────────────────────────────────────────────

interface PerPathSummary {
  factual_avg: number;
  citation_avg: number;
  specificity_avg: number;
}

interface PairwiseSummary {
  brainWinsCount2of3: number;
  brainWinsCountAllAxes: number;
  perAxisWinCount: { factual: number; citation: number; specificity: number };
  perAxisLossCount: { factual: number; citation: number; specificity: number };
  perAxisTieCount: { factual: number; citation: number; specificity: number };
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function summarizePerPath(scores: CaseScores[], pathKey: 'brain' | 'grep' | 'longCtx'): PerPathSummary {
  return {
    factual_avg: avg(scores.map((s) => s.paths[pathKey].factual_accuracy)),
    citation_avg: avg(scores.map((s) => s.paths[pathKey].citation_correctness)),
    specificity_avg: avg(scores.map((s) => s.paths[pathKey].specificity)),
  };
}

function pairwise(scores: CaseScores[], baseline: 'grep' | 'longCtx'): PairwiseSummary {
  let brainWinsCount2of3 = 0;
  let brainWinsCountAllAxes = 0;
  const perAxisWinCount = { factual: 0, citation: 0, specificity: 0 };
  const perAxisLossCount = { factual: 0, citation: 0, specificity: 0 };
  const perAxisTieCount = { factual: 0, citation: 0, specificity: 0 };

  for (const s of scores) {
    const b = s.paths.brain;
    const x = s.paths[baseline];
    const axes: ('factual_accuracy' | 'citation_correctness' | 'specificity')[] = [
      'factual_accuracy',
      'citation_correctness',
      'specificity',
    ];
    let wins = 0;
    for (const ax of axes) {
      const axShort = ax.replace('factual_accuracy', 'factual')
        .replace('citation_correctness', 'citation')
        .replace('specificity', 'specificity') as 'factual' | 'citation' | 'specificity';
      if (b[ax] > x[ax]) {
        perAxisWinCount[axShort] += 1;
        wins += 1;
      } else if (b[ax] < x[ax]) {
        perAxisLossCount[axShort] += 1;
      } else {
        perAxisTieCount[axShort] += 1;
      }
    }
    if (wins >= 2) brainWinsCount2of3 += 1;
    if (wins === 3) brainWinsCountAllAxes += 1;
  }

  return { brainWinsCount2of3, brainWinsCountAllAxes, perAxisWinCount, perAxisLossCount, perAxisTieCount };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('[t1-judge] OPENROUTER_API_KEY is required');
    process.exit(1);
  }

  const raw = await fs.readFile(RUNS_PATH, 'utf-8');
  const file = JSON.parse(raw) as { rows: RunRow[] };
  const rows = file.rows;
  console.log(`[t1-judge] judging ${rows.length} cases…`);

  const scores: CaseScores[] = [];
  for (const r of rows) {
    console.log(`[t1-judge]   ${r.caseId}…`);
    try {
      const s = await judgeCase(r);
      scores.push(s);
      // Persist incrementally
      await fs.writeFile(
        SCORES_PATH,
        JSON.stringify({ generatedAt: new Date().toISOString(), scores, summary: null }, null, 2),
      );
    } catch (err) {
      console.error(`[t1-judge]   ${r.caseId} FAILED:`, err instanceof Error ? err.message : err);
      // Skip on failure — better to have partial scores than crash
    }
  }

  // Aggregate
  const summary = {
    n: scores.length,
    perPath: {
      brain: summarizePerPath(scores, 'brain'),
      grep: summarizePerPath(scores, 'grep'),
      longCtx: summarizePerPath(scores, 'longCtx'),
    },
    pairwise: {
      brain_vs_grep: pairwise(scores, 'grep'),
      brain_vs_longCtx: pairwise(scores, 'longCtx'),
    },
    pass_bar_brain_vs_grep: pairwise(scores, 'grep').brainWinsCount2of3 >= 7 ? 'PASS' : 'FAIL',
    pass_bar_brain_vs_longCtx: pairwise(scores, 'longCtx').brainWinsCount2of3 >= 7 ? 'PASS' : 'FAIL',
    overall: 'PENDING',
  } as Record<string, unknown>;
  summary.overall =
    summary.pass_bar_brain_vs_grep === 'PASS' && summary.pass_bar_brain_vs_longCtx === 'PASS'
      ? 'PASS'
      : 'FAIL';

  await fs.writeFile(
    SCORES_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), scores, summary }, null, 2),
  );

  // Pretty-print summary
  console.log('\n=== T1-RECALL FINAL SUMMARY ===');
  console.log(`n=${scores.length}`);
  console.log('\nPer-path averages (factual / citation / specificity):');
  for (const key of ['brain', 'grep', 'longCtx'] as const) {
    const p = (summary.perPath as Record<string, PerPathSummary>)[key];
    console.log(
      `  ${key.padEnd(10)} ${p.factual_avg.toFixed(2)} / ${p.citation_avg.toFixed(2)} / ${p.specificity_avg.toFixed(2)}`,
    );
  }
  console.log('\nPairwise (Brain wins ≥2 of 3 axes per case):');
  const pg = (summary.pairwise as Record<string, PairwiseSummary>).brain_vs_grep;
  const pl = (summary.pairwise as Record<string, PairwiseSummary>).brain_vs_longCtx;
  console.log(`  Brain vs Grep:    ${pg.brainWinsCount2of3}/${scores.length}  (allAxes=${pg.brainWinsCountAllAxes})`);
  console.log(`  Brain vs LongCtx: ${pl.brainWinsCount2of3}/${scores.length}  (allAxes=${pl.brainWinsCountAllAxes})`);
  console.log(`\nPass bar (≥7/10 wins on 2 of 3 axes vs BOTH baselines):`);
  console.log(`  vs Grep:     ${summary.pass_bar_brain_vs_grep}`);
  console.log(`  vs LongCtx:  ${summary.pass_bar_brain_vs_longCtx}`);
  console.log(`  Overall:     ${summary.overall}`);
}

main().catch((err) => {
  console.error('[t1-judge] unexpected failure:', err);
  process.exit(1);
});
