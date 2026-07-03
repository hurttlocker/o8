#!/usr/bin/env node
/**
 * Hard-task parity experiment (2026-07-03) — the benchmark's missing number.
 *
 * SAME hard review task, two context conditions × two models:
 *   RAW     — full ~18K-token change batch (the "native frontier" pattern)
 *   WINDOW  — ~2K-token digest artifact (the o8 decisions-only pattern)
 * Models: claude-fable-5, claude-opus-4-8. Exact token usage recorded per call.
 * Question: does windowed Fable hold review quality at a fraction of the bill?
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const KEY = process.env.O8_FABLE_ANTHROPIC_API_KEY;
if (!KEY) throw new Error('key missing');

const RAW = readFileSync(join(DIR, 'raw-batch.txt'), 'utf8');
const COMPACT = readFileSync(join(DIR, 'compact-artifact.txt'), 'utf8');

const TASK = [
  'You are the final reviewer for a high-stakes change batch to o8 (a governance layer for autonomous engineering fleets). This batch builds "Fable mode" — a decisions-only window for a per-token-metered orchestrator model. It is about to ship. Review it adversarially.',
  '',
  'Produce EXACTLY this structure:',
  'VERDICT: SHIP or HOLD',
  'FINDINGS: a numbered list (max 10) of concrete issues or load-bearing subtleties a reviewer must verify — each as "N. [severity: high|med|low] file — one-to-two sentence description". Include correctness risks, security/billing risks, and precedence/interaction subtleties. Do NOT pad the list; only include things you genuinely see.',
  'MISSED-BY-TESTS: 1-3 risks the described tests do not cover.',
  'ASSESSMENT: one paragraph.',
].join('\n');

async function call(model, artifact, label) {
  const t0 = Date.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 6000,
      system: [{ type: 'text', text: TASK, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `<change_batch>\n${artifact}\n</change_batch>` }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${label}: ${data?.error?.message}`);
  const text = (data.content ?? []).map((b) => b.text ?? '').join('').trim();
  const out = {
    label, model,
    ms: Date.now() - t0,
    usage: data.usage,
    text,
  };
  console.log(`[done] ${label}: in=${data.usage.input_tokens} cacheR=${data.usage.cache_read_input_tokens} out=${data.usage.output_tokens} (${Math.round(out.ms / 1000)}s)`);
  return out;
}

const jobs = [
  ['claude-fable-5', RAW, 'fable-RAW'],
  ['claude-fable-5', COMPACT, 'fable-WINDOW'],
  ['claude-opus-4-8', RAW, 'opus-RAW'],
  ['claude-opus-4-8', COMPACT, 'opus-WINDOW'],
];
const results = [];
for (const [model, artifact, label] of jobs) {
  results.push(await call(model, artifact, label));
}
writeFileSync(join(DIR, 'hard-task-results.json'), JSON.stringify(results, null, 2));
console.log(`\nsaved → ${join(DIR, 'hard-task-results.json')}`);
