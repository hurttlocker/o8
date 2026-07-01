/**
 * Targeting Machine — the rationale money-shot.
 *
 * The deterministic scorer gives every file a heuristic one-liner (scorer.ts).
 * This upgrades the TOP files' rationales with the CONFIGURED cheap triage model
 * — the Brain's cheap Class-A path (callHaiku: warm Haiku CLI, subscription-
 * billed, spend-adjacent) — in ONE batched, schema-validated JSON call, with the
 * heuristic rationale as the per-file fallback so the triage never dead-ends.
 *
 * Why batched, not one call per file: a per-file fan-out means N cold `claude`
 * spawns racing an 8s timeout (measured: 20 parallel cold calls all fell back
 * after 16s). One batched call is a single warm/cold request — dramatically
 * cheaper, faster, and more reliable, and still schema-validated JSON. Bounded to
 * the top `RATIONALE_LLM_LIMIT` files (the ones an operator actually reads).
 */

import { callHaiku } from '@/lib/cortex/qa/llm/haiku-adapter';
import { resolveTargetingTriageSync } from '@/lib/operator/defaults';
import type { TargetScore } from './scorer';

/** Cap on how many top files get a live cheap-model rationale (cost bound). */
export const RATIONALE_LLM_LIMIT = 25;

function buildBatchPrompt(targets: TargetScore[]): string {
  const rows = targets.map((t, i) => {
    const s = t.signals;
    return `${i}. ${t.path} | LOC ${s.loc} | symbols ${s.symbolCount} | imported_by ${s.inbound} | recent_commits ${s.churn} | impact ${t.impact}/5 opportunity ${t.opportunity}/5`;
  });
  return [
    'You are triaging a code repository to tell an operator WHERE to point their expensive AI coding agents.',
    'For EACH numbered file below, write ONE terse sentence (max ~16 words) on why it is (or is not) worth pointing an agent at —',
    'focus on blast-radius (how many files depend on it) and opportunity (size, churn). Be concrete; name the numbers.',
    'Respond ONLY as a compact JSON array, one object per file, using the SAME index:',
    '[{"i":0,"rationale":"<one sentence>"}, {"i":1,"rationale":"..."}]',
    '',
    ...rows,
  ].join('\n');
}

function cap(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 160 ? `${one.slice(0, 157)}…` : one;
}

/**
 * Parse a batched `[{i, rationale}]` response into an index→rationale map. PURE +
 * exported for tests. Tolerates code fences / prose around the JSON array and
 * skips any malformed entry (that file keeps its heuristic rationale).
 */
export function parseBatchRationales(raw: string): Map<number, string> {
  const out = new Map<number, string>();
  const text = raw.trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return out;
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!Array.isArray(arr)) return out;
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const i = typeof o.i === 'number' ? o.i : Number(o.i);
    const rationale = typeof o.rationale === 'string' ? o.rationale.trim() : '';
    if (Number.isInteger(i) && i >= 0 && rationale.length >= 4) out.set(i, cap(rationale));
  }
  return out;
}

/**
 * Upgrade the top-N targets' rationales with the cheap triage model in one
 * batched call. Any file the model omits or mangles keeps its deterministic
 * heuristic rationale; a total failure (model off / not signed in) leaves every
 * rationale heuristic. Returns a NEW array; never throws.
 */
export async function applyLlmRationales(targets: TargetScore[], limit = RATIONALE_LLM_LIMIT): Promise<TargetScore[]> {
  // Touch the triage-tier setting so the money-shot is attributable to config
  // (the cheap path callHaiku uses is the Brain's configured Class-A cascade).
  void resolveTargetingTriageSync();

  const head = targets.slice(0, limit);
  if (head.length === 0) return targets;

  let map = new Map<number, string>();
  try {
    // One batched call — cold-start-tolerant timeout (a per-file fan-out of cold
    // spawns was measured to time out; a single request is reliable).
    const text = await callHaiku(buildBatchPrompt(head), { timeoutMs: 22_000 });
    map = parseBatchRationales(text);
  } catch {
    return targets; // model unreachable / disabled → all heuristic, no throw
  }

  return targets.map((t, i) => {
    const upgraded = map.get(i);
    return upgraded ? { ...t, rationale: upgraded } : t;
  });
}
