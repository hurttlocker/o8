/**
 * Cortex Q&A smoke eval — `npm run smoke:qa`
 *
 * 6-case ship gate, runs in <2 min, exits 0/1 on PASS/FAIL. Replaces the
 * 30-case heavy eval (`npm run eval:qa`) as the ship gate; the heavy eval
 * is demoted to a nightly cron.
 *
 * Pure substring rubric — no Sonnet judge — so latency stays low.
 *
 * The 6 cases are picked from cases.json (one per category):
 *   - All have substrate today (no knownGap).
 *   - Picked by best recent factual_accuracy in qa_eval_runs. Where a
 *     category has no case scoring ≥0.6 we pick the highest scorer and
 *     mark it "weakest link" so a regression there is the canary.
 *
 * Environment:
 *   OPENROUTER_API_KEY  — recommended. Sets O8_EVAL_MODE=1 so the pipeline
 *                         routes through OpenRouter instead of the slow CLI
 *                         bootstrap. Without it, smoke still runs but may
 *                         fall through to heuristics (slower, may fail).
 *
 * Exit codes:
 *   0 — all 6 cases passed
 *   1 — any case failed
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { askCortex } from '@/lib/cortex/qa/ask';

// ── Locked smoke case set ─────────────────────────────────────────────────────

interface SmokeCaseEntry {
  id: string;
  weakestLink?: boolean; // true when category has no ≥0.6 case to pick from
}

// One per category. Order: ownership / decisions / processes / incidents / specs / cross-repo.
// Picks justified in PR body; rationale lives in /tmp/cortex-engineering-brain-indexer-round3.md.
const SMOKE_CASES: SmokeCaseEntry[] = [
  { id: 'qa-005', weakestLink: true }, // ownership — best non-gap (avg 0.29)
  { id: 'qa-007' }, // decisions — perfect (avg 1.0)
  { id: 'qa-011' }, // processes — best non-gap (avg 0.61)
  { id: 'qa-018' }, // incidents — best non-gap (avg 0.73)
  { id: 'qa-025', weakestLink: true }, // specs — best non-gap (avg 0.05)
  { id: 'qa-028', weakestLink: true }, // cross-repo — best non-gap (avg 0.29)
];

// ── Loader ────────────────────────────────────────────────────────────────────

interface RawCase {
  id: string;
  category: string;
  repoPath: string;
  question: string;
  expectedAnswer: string | null;
  smokeExpectedFacts?: string[];
  knownGap?: string;
}

async function loadCases(): Promise<RawCase[]> {
  const casesPath = path.resolve(process.cwd(), 'tests/qa-eval/cases.json');
  const raw = await fs.readFile(casesPath, 'utf-8');
  const file = JSON.parse(raw) as { cases: RawCase[] };
  const wanted = new Set(SMOKE_CASES.map((s) => s.id));
  const found = file.cases.filter((c) => wanted.has(c.id));
  if (found.length !== SMOKE_CASES.length) {
    const missing = SMOKE_CASES.map((s) => s.id).filter(
      (id) => !found.find((c) => c.id === id),
    );
    throw new Error(
      `[smoke:qa] cases.json is missing ${missing.length} smoke cases: ${missing.join(', ')}`,
    );
  }
  return found;
}

// ── Rubric ────────────────────────────────────────────────────────────────────

interface CheckResult {
  passed: boolean;
  reason: string;
}

function checkAnswer(rawCase: RawCase, answer: string, citationCount: number): CheckResult {
  // Rule 1: non-empty (>10 chars after trim)
  const trimmed = answer.trim();
  if (trimmed.length <= 10) {
    return { passed: false, reason: `empty/short answer (${trimmed.length} chars)` };
  }

  // Rule 3: must NOT contain the no-row fallback string
  const lower = trimmed.toLowerCase();
  if (lower.includes("i don't have that information yet")) {
    return { passed: false, reason: 'no-row fallback string detected' };
  }

  // Rule 2: must contain at least one smokeExpectedFacts substring (case-insensitive)
  const facts = rawCase.smokeExpectedFacts ?? [];
  if (facts.length === 0) {
    return {
      passed: false,
      reason: 'case is missing smokeExpectedFacts (smoke harness misconfigured)',
    };
  }
  const hit = facts.find((f) => lower.includes(f.toLowerCase()));
  if (!hit) {
    return {
      passed: false,
      reason: `none of [${facts.join(' | ')}] found in answer`,
    };
  }

  // Rule 4: at least 1 citation
  if (citationCount < 1) {
    return { passed: false, reason: 'zero citations' };
  }

  return { passed: true, reason: `hit "${hit}", citations=${citationCount}` };
}

// ── Reporting ─────────────────────────────────────────────────────────────────

interface RowReport {
  caseId: string;
  category: string;
  weakestLink: boolean;
  passed: boolean;
  latencyMs: number;
  preview: string;
  reason: string;
}

function previewAnswer(answer: string, n = 80): string {
  const flat = answer.replace(/\s+/g, ' ').trim();
  if (flat.length <= n) return flat;
  return flat.slice(0, n - 1) + '…';
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + ' '.repeat(n - s.length);
}

function printTable(rows: RowReport[]): void {
  console.log('');
  console.log(
    `| ${pad('case_id', 8)} | ${pad('category', 11)} | ${pad('passed', 6)} | ${pad('latency', 8)} | answer (first 80 chars)`,
  );
  console.log(
    `| ${pad('-', 8).replace(/ /g, '-')} | ${pad('-', 11).replace(/ /g, '-')} | ${pad('-', 6).replace(/ /g, '-')} | ${pad('-', 8).replace(/ /g, '-')} | ${'-'.repeat(80)}`,
  );
  for (const r of rows) {
    const passCell = r.passed ? 'PASS' : 'FAIL';
    const flag = r.weakestLink ? '*' : ' ';
    const latency = `${r.latencyMs}ms`;
    console.log(
      `|${flag}${pad(r.caseId, 7)} | ${pad(r.category, 11)} | ${pad(passCell, 6)} | ${pad(latency, 8)} | ${r.preview}`,
    );
    if (!r.passed) {
      console.log(`|         |             |        |          | ↳ ${r.reason}`);
    }
  }
  console.log('');
  console.log('* = weakest link (category has no case scoring ≥0.6 historically)');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Force eval mode so pipeline uses OpenRouter (fast) instead of CLI bootstrap.
  // Without OPENROUTER_API_KEY the pipeline falls through to heuristics — emit a
  // warning but still run.
  process.env.O8_EVAL_MODE = process.env.O8_EVAL_MODE ?? '1';

  if (!process.env.OPENROUTER_API_KEY) {
    console.warn(
      '[smoke:qa] WARN: OPENROUTER_API_KEY is unset. Pipeline will fall through to heuristics — runs may be slower or fail.',
    );
  }

  const cases = await loadCases();
  const meta = new Map<string, SmokeCaseEntry>(
    SMOKE_CASES.map((c) => [c.id, c]),
  );

  // Order rows in the table the same way the smoke list is locked.
  const ordered = SMOKE_CASES.map((s) => cases.find((c) => c.id === s.id)!);

  const rows: RowReport[] = [];
  const latencies: number[] = [];

  for (const c of ordered) {
    const entry = meta.get(c.id)!;
    const start = Date.now();
    let answer = '';
    let citations = 0;
    let reason = '';
    let passed = false;

    try {
      const result = await askCortex(c.question, c.repoPath, { bypassCache: true });
      answer = result.answer;
      citations = result.citations.length;
      const check = checkAnswer(c, answer, citations);
      passed = check.passed;
      reason = check.reason;
    } catch (err) {
      reason = `askCortex threw: ${err instanceof Error ? err.message : String(err)}`;
      passed = false;
    }

    const latencyMs = Date.now() - start;
    latencies.push(latencyMs);

    rows.push({
      caseId: c.id,
      category: c.category,
      weakestLink: !!entry.weakestLink,
      passed,
      latencyMs,
      preview: previewAnswer(answer),
      reason,
    });

    console.log(
      `[smoke:qa] ${c.id} ${c.category} ${passed ? 'PASS' : 'FAIL'} ${latencyMs}ms`,
    );
  }

  printTable(rows);

  // p50 latency
  const sorted = [...latencies].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const p50 =
    sorted.length % 2 === 0
      ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      : sorted[mid];
  const total = latencies.reduce((a, b) => a + b, 0);
  const passCount = rows.filter((r) => r.passed).length;

  console.log(`[smoke:qa] result: ${passCount}/${rows.length} passed`);
  console.log(`[smoke:qa] latency: total=${total}ms p50=${p50}ms`);

  if (passCount === rows.length) {
    console.log('[smoke:qa] PASS');
    process.exitCode = 0;
  } else {
    console.error('[smoke:qa] FAIL');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[smoke:qa] unexpected failure:', err);
  process.exitCode = 1;
});
