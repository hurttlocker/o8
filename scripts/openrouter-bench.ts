/**
 * OpenRouter Class A primary bake-off harness — epic #915 phase 1.7.1.
 *
 * Probes a list of OpenRouter chat models with two realistic Cortex Q&A
 * payloads (a 1-fact lookup + a 5-fact spec enumeration) and reports p50/p95
 * wall-time-to-last-token, quality (rule-based), and total errors.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-v1-... npx tsx scripts/openrouter-bench.ts
 *
 * Output: markdown table to stdout. The 5/5 calls per prompt mirror the
 * 2026-04-30 bake-off so numbers are comparable.
 */

import { OPENROUTER_BENCH_SYSTEM_PROMPT_V1 } from '../src/lib/prompts/v1/cortex-compose';

// 1-fact lookup — mirrors a real Q&A factual_accuracy case (which directive
// owns the 800-line ceiling for cortex-ide?).
const ONE_FACT_USER = `Question: What is the file-size ceiling enforced for the cortex-ide repo?
Repo: /workspace/o8

Available rows:
[
  {
    "citationHandle": "D-014",
    "kind": "directive",
    "excerpt": "Respect the 800-line file ceiling — if your changes would push a file past 800 lines, decompose first.",
    "fields": { "scope": "repo", "repo": "cortex-ide", "id": "directive-seed-cortex-ide-800-line-ceiling" }
  },
  {
    "citationHandle": "D-021",
    "kind": "directive",
    "excerpt": "Inline styles only — never use CSS classes for theme surfaces.",
    "fields": { "scope": "repo", "repo": "cortex-ide", "id": "directive-seed-cortex-ide-inline-styles-only" }
  },
  {
    "citationHandle": "D-007",
    "kind": "directive",
    "excerpt": "Phosphor SVG only — never use icon component libs in the Tauri webview.",
    "fields": { "scope": "repo", "repo": "cortex-ide", "id": "directive-seed-cortex-ide-phosphor-svg-only" }
  }
]`;

// 5-fact spec — multi-fact enumeration (Class A worst case for chatty models).
const FIVE_FACT_USER = `Question: What are the latency-budget rules in the o8 performance directive — list every limit.
Repo: /workspace/o8

Available rows:
[
  {
    "citationHandle": "D-101",
    "kind": "directive",
    "excerpt": "Bootstrap render budget: first paint within 250ms of window open.",
    "fields": { "scope": "repo", "repo": "cortex-ide", "id": "directive-seed-perf-bootstrap-250ms" }
  },
  {
    "citationHandle": "D-102",
    "kind": "directive",
    "excerpt": "API route p50 budget: 100ms for cached reads, 400ms for uncached.",
    "fields": { "scope": "repo", "repo": "cortex-ide", "id": "directive-seed-perf-api-route" }
  },
  {
    "citationHandle": "D-103",
    "kind": "directive",
    "excerpt": "WebSocket message round-trip budget: 50ms p95 on loopback.",
    "fields": { "scope": "repo", "repo": "cortex-ide", "id": "directive-seed-perf-ws-rtt" }
  },
  {
    "citationHandle": "D-104",
    "kind": "directive",
    "excerpt": "SQLite query budget: 5ms p50 for indexed reads, 25ms p95 for full scans.",
    "fields": { "scope": "repo", "repo": "cortex-ide", "id": "directive-seed-perf-sqlite" }
  },
  {
    "citationHandle": "D-105",
    "kind": "directive",
    "excerpt": "Streaming first-token budget: 800ms TTFT for any LLM-backed surface.",
    "fields": { "scope": "repo", "repo": "cortex-ide", "id": "directive-seed-perf-llm-ttft" }
  }
]`;

interface CallResult {
  ms: number;
  text: string;
  error?: string;
  servedModel?: string;
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 30_000; // 30s per call so slow models don't false-fail.

async function callOnce(model: string, userPrompt: string): Promise<CallResult> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return { ms: 0, text: '', error: 'OPENROUTER_API_KEY missing' };
  }

  const start = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://o8.run',
        'X-Title': 'o8 Cortex Q&A bench',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: OPENROUTER_BENCH_SYSTEM_PROMPT_V1 },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 512,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - start;
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ms, text: '', error: `HTTP ${res.status}: ${errText.slice(0, 160)}` };
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
    };
    const text = json.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) {
      return { ms, text: '', error: 'empty content', servedModel: json.model };
    }
    return { ms, text, servedModel: json.model };
  } catch (err) {
    const ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return { ms, text: '', error: message };
  }
}

function p50(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

// Quality grading — rule-based, capped at 3 per prompt to match the prior
// bake-off's 0/3..3/3 scale.
//
// 1-fact: 3 points = (a) cites D-014, (b) mentions "800", (c) doesn't say "I don't have".
// 5-fact: 3 points = (a) cites all 5 handles D-101..D-105, (b) mentions all 5 numbers
//                    (250, 400, 50, 5, 800), (c) one bullet/sentence per fact (>= 5 commas
//                    or newlines indicating enumeration).
function gradeOneFact(text: string): number {
  if (!text) return 0;
  let score = 0;
  if (/\bD[-_]?014\b/i.test(text)) score++;
  if (/\b800\b/.test(text)) score++;
  if (!/i\s+don['']?t\s+have/i.test(text)) score++;
  return score;
}

function gradeFiveFact(text: string): number {
  if (!text) return 0;
  let score = 0;
  const handles = ['D-101', 'D-102', 'D-103', 'D-104', 'D-105'];
  const handlesFound = handles.every((h) =>
    new RegExp(h.replace('-', '[-_]?'), 'i').test(text),
  );
  if (handlesFound) score++;
  // Required numeric tokens (one per directive). Models write "250ms" not "250 ms"
  // so word-boundary won't match; allow optional unit suffix.
  const requiredNumbers = ['250', '400', '50', '5', '800'];
  const numbersFound = requiredNumbers.every((n) => new RegExp(`(?<!\\d)${n}(?!\\d)`).test(text));
  if (numbersFound) score++;
  // Enumeration shape — at least 5 separators (semicolons, line breaks, or
  // sentence ends) indicating each fact got its own beat.
  const semicolons = (text.match(/;\s/g) ?? []).length;
  const newlines = (text.match(/\n[-*\d•·\s]/g) ?? []).length;
  const sentences = (text.match(/\.\s/g) ?? []).length;
  if (semicolons + newlines + sentences >= 4) score++;
  return score;
}

interface ModelReport {
  model: string;
  oneFactP50: number;
  oneFactP95: number;
  fiveFactP50: number;
  fiveFactP95: number;
  oneFactQuality: number; // 0..3
  fiveFactQuality: number; // 0..3
  errors: number;
  errorSamples: string[];
  servedModels: Set<string>;
}

async function probeModel(model: string, calls: number): Promise<ModelReport> {
  const oneFactTimes: number[] = [];
  const fiveFactTimes: number[] = [];
  let oneFactQ = 0;
  let fiveFactQ = 0;
  let errors = 0;
  const errorSamples: string[] = [];
  const servedModels = new Set<string>();

  for (let i = 0; i < calls; i++) {
    const r = await callOnce(model, ONE_FACT_USER);
    if (r.servedModel) servedModels.add(r.servedModel);
    if (r.error) {
      errors++;
      if (errorSamples.length < 3) errorSamples.push(r.error);
    } else {
      oneFactTimes.push(r.ms);
      oneFactQ = Math.max(oneFactQ, gradeOneFact(r.text));
    }
  }
  for (let i = 0; i < calls; i++) {
    const r = await callOnce(model, FIVE_FACT_USER);
    if (r.servedModel) servedModels.add(r.servedModel);
    if (r.error) {
      errors++;
      if (errorSamples.length < 3) errorSamples.push(r.error);
    } else {
      fiveFactTimes.push(r.ms);
      fiveFactQ = Math.max(fiveFactQ, gradeFiveFact(r.text));
    }
  }
  return {
    model,
    oneFactP50: p50(oneFactTimes),
    oneFactP95: p95(oneFactTimes),
    fiveFactP50: p50(fiveFactTimes),
    fiveFactP95: p95(fiveFactTimes),
    oneFactQuality: oneFactQ,
    fiveFactQuality: fiveFactQ,
    errors,
    errorSamples,
    servedModels,
  };
}

const CANDIDATES = [
  'deepseek/deepseek-v4-pro',
  'x-ai/grok-4.1-fast',
  'openai/gpt-5.4-nano',
  'deepseek/deepseek-chat',
  'google/gemini-2.5-flash-lite',
  'openai/gpt-5-nano',
];

function fmtMs(ms: number): string {
  return ms === 0 ? '—' : `${ms} ms`;
}

async function main() {
  const calls = Number(process.env.BENCH_CALLS ?? '5');
  console.log(`# OpenRouter Class A primary bake-off (epic #915 phase 1.7.1)`);
  console.log(`# Date: ${new Date().toISOString().slice(0, 10)}`);
  console.log(`# Calls per prompt: ${calls} (1-fact + 5-fact, max_tokens=512, temperature=0)`);
  console.log('');

  const reports: ModelReport[] = [];
  for (const model of CANDIDATES) {
    process.stderr.write(`[bench] probing ${model}...\n`);

    const r = await probeModel(model, calls);
    reports.push(r);
    process.stderr.write(
      `[bench]   1f p50=${r.oneFactP50}ms 5f p50=${r.fiveFactP50}ms quality=${r.oneFactQuality}/3 + ${r.fiveFactQuality}/3 errors=${r.errors}\n`,
    );
    if (r.errorSamples.length > 0) {
      for (const sample of r.errorSamples) process.stderr.write(`[bench]     err: ${sample}\n`);
    }
    if (r.servedModels.size > 0 && !r.servedModels.has(model)) {
      process.stderr.write(
        `[bench]     served by: ${[...r.servedModels].join(', ')}\n`,
      );
    }
  }

  console.log('| model | p50 1-fact | p95 1-fact | p50 5-fact | p95 5-fact | quality (1f + 5f) | errors |');
  console.log('|-------|-----------:|-----------:|-----------:|-----------:|:-----------------:|-------:|');
  for (const r of reports) {
    console.log(
      `| \`${r.model}\` | ${fmtMs(r.oneFactP50)} | ${fmtMs(r.oneFactP95)} | ${fmtMs(r.fiveFactP50)} | ${fmtMs(r.fiveFactP95)} | ${r.oneFactQuality}/3 + ${r.fiveFactQuality}/3 | ${r.errors} |`,
    );
  }

  // Pick the winner: highest combined quality, tiebreaker lowest p95 sum, ignoring all-errored.
  const live = reports.filter((r) => r.oneFactP50 > 0 || r.fiveFactP50 > 0);
  const ranked = [...live].sort((a, b) => {
    const qA = a.oneFactQuality + a.fiveFactQuality;
    const qB = b.oneFactQuality + b.fiveFactQuality;
    if (qA !== qB) return qB - qA;
    const lA = a.oneFactP95 + a.fiveFactP95;
    const lB = b.oneFactP95 + b.fiveFactP95;
    return lA - lB;
  });
  console.log('');
  console.log('## Ranking (quality desc, then p95-latency-sum asc)');
  ranked.forEach((r, i) => {
    console.log(
      `${i + 1}. \`${r.model}\` — quality ${r.oneFactQuality + r.fiveFactQuality}/6, p95 sum ${r.oneFactP95 + r.fiveFactP95} ms, errors ${r.errors}`,
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
