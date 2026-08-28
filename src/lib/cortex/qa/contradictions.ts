/**
 * Contradiction detector — epic #915 sub-issue 3 wave B.
 *
 * When a directive says X but a merged outcome did Y, surfaces
 * "Conflict noted, resolve in directive?" as a `Contradiction` object.
 *
 * Detection strategy:
 *   Strategy B (structural) first — cheap heuristic to find candidate pairs
 *   without burning LLM calls:
 *     - Directive scope:repo matches outcome repo
 *     - Directive priority >= 7 + outcome.outcome === 'completed' + outcome had prNumber
 *     - Simple keyword overlap heuristic keeps pairs relevant
 *
 *   Strategy A (Flash pair-pass) on top 5 candidate pairs:
 *     - Gemini Flash with a yes/no contradiction prompt
 *     - Returns { contradicts: bool, summary: string }
 *
 * Failures: return empty array, log warning. Never throw.
 */

import 'server-only';

import type { TypedRow } from '@/lib/cortex/qa/types';

export interface Contradiction {
  /** Citation handle of the directive row (e.g. 'seed-cortex-ide-800-line-ceiling'). */
  directiveId: string;
  /** Citation row id of the outcome row. */
  outcomeId: string;
  /** PR number cross-link, if the outcome was attached to a PR. */
  prNumber?: number;
  /** ≤2 sentences explaining the conflict. */
  summary: string;
}

// ── Structural pair builder (Strategy B) ─────────────────────────────────────

interface CandidatePair {
  directive: TypedRow;
  outcome: TypedRow;
  /** Combined relevance rank — lower is better. */
  rank: number;
}

/**
 * Build candidate (directive, outcome) pairs using structural heuristics:
 *   - Same repo scope (directive.fields.scope matches outcome.fields.repoPath)
 *   - Outcome is completed / merged
 *   - Keyword overlap > 0 (at least one shared content word)
 *
 * Returns pairs sorted by rank (most likely contradictions first), capped at 5.
 */
function buildCandidatePairs(rows: TypedRow[]): CandidatePair[] {
  const directives = rows.filter((r) => r.citation.kind === 'directive');
  const outcomes = rows.filter((r) => r.citation.kind === 'outcome');

  if (directives.length === 0 || outcomes.length === 0) return [];

  const pairs: CandidatePair[] = [];

  for (const directive of directives) {
    const dFields = directive.fields as Record<string, unknown>;
    const dScope = typeof dFields.scope === 'string' ? dFields.scope : '';
    const dTitle = typeof dFields.title === 'string' ? dFields.title : '';
    const dBody = typeof dFields.body === 'string' ? dFields.body : '';
    const dPriority = typeof dFields.priority === 'number' ? dFields.priority : 0;
    const dExcerpt = directive.citation.excerpt ?? '';
    const dWords = tokenize(`${dTitle} ${dBody} ${dExcerpt}`);

    for (const outcome of outcomes) {
      const oFields = outcome.fields as Record<string, unknown>;
      const oRepoPath = typeof oFields.repoPath === 'string' ? oFields.repoPath : '';
      const oOutcome = typeof oFields.outcome === 'string' ? oFields.outcome : '';
      const oSummary = typeof oFields.summary === 'string' ? oFields.summary : '';
      const oPlanText = typeof oFields.planText === 'string' ? oFields.planText : '';
      // Scope filter: directive must be scoped to the same repo as the outcome,
      // OR have no scope (global directive — applies everywhere).
      if (dScope && oRepoPath && !oRepoPath.includes(dScope) && !dScope.includes(oRepoPath)) {
        continue;
      }

      // Only check outcomes that completed (not skipped/failed without a merge).
      if (oOutcome !== 'completed' && oOutcome !== 'merged') continue;

      // Keyword overlap heuristic — skip clearly unrelated pairs.
      const oWords = tokenize(`${oSummary} ${oPlanText}`);
      const overlap = countOverlap(dWords, oWords);
      if (overlap === 0) continue;

      // Rank: prefer high-priority directives + high-overlap pairs.
      const rank = (dPriority >= 7 ? 0 : 10) + (10 - Math.min(overlap, 10));

      pairs.push({ directive, outcome, rank });
    }
  }

  return pairs.sort((a, b) => a.rank - b.rank).slice(0, 5);
}

/** Tokenize text into lowercase content words (strips stopwords). */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'it', 'in', 'of', 'to', 'and', 'or', 'for',
  'on', 'at', 'be', 'by', 'as', 'we', 'do', 'not', 'with', 'this',
  'that', 'was', 'are', 'has', 'have', 'had', 'will', 'would', 'should',
  'could', 'from', 'all', 'but', 'no', 'can', 'use', 'used', 'using',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
  );
}

function countOverlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const w of a) {
    if (b.has(w)) count++;
  }
  return count;
}

// ── Flash pair-pass (Strategy A) ─────────────────────────────────────────────

interface FlashContradictionResponse {
  contradicts: boolean;
  summary: string;
}

async function callFlashContradictionCheck(
  directive: TypedRow,
  outcome: TypedRow,
  apiKey: string,
): Promise<FlashContradictionResponse | null> {
  const dFields = directive.fields as Record<string, unknown>;
  const oFields = outcome.fields as Record<string, unknown>;

  const dTitle = typeof dFields.title === 'string' ? dFields.title : directive.citation.rowId;
  const dBody = (typeof dFields.body === 'string' ? dFields.body : directive.citation.excerpt ?? '').slice(0, 400);
  const oSummary = (typeof oFields.summary === 'string' ? oFields.summary : outcome.citation.excerpt ?? '').slice(0, 400);
  const oPlanText = (typeof oFields.planText === 'string' ? oFields.planText : '').slice(0, 400);

  const prompt = `Directive D: "${dTitle}"
Body: "${dBody}"

Outcome O: Summary="${oSummary}" Plan="${oPlanText}"

Does the outcome contradict the directive? Return strictly this JSON with no other text:
{"contradicts":bool,"summary":"<=2 sentences if contradicts=true, empty string otherwise"}`;

  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.0, maxOutputTokens: 150 },
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );

    if (!res.ok) return null;

    const json = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!rawText.trim()) return null;

    // Extract JSON from the response (model may wrap in markdown).
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as FlashContradictionResponse;
    if (typeof parsed.contradicts !== 'boolean') return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect contradictions between directive rows and outcome rows.
 *
 * Input:
 *   rows    — the TypedRows used to compose the answer (from retrievers)
 *   answer  — the final composed answer text (currently unused but reserved
 *             for future keyword extraction)
 *
 * Output: zero or more Contradiction objects.
 *
 * Failures: return [], log warning. Never throw.
 */
export async function detectContradictions(input: {
  rows: TypedRow[];
  answer: string;
}): Promise<Contradiction[]> {
  try {
    const pairs = buildCandidatePairs(input.rows);
    if (pairs.length === 0) return [];

    const apiKey =
      process.env.GOOGLE_AI_API_KEY ??
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
      process.env.GEMINI_API_KEY;

    if (!apiKey) {
      // No Flash key — fall back to structural contradictions only.
      // Return pairs where directive priority >= 7 (high-confidence structural hit).
      return pairs
        .filter((p) => {
          const priority = (p.directive.fields as Record<string, unknown>).priority;
          return typeof priority === 'number' && priority >= 7;
        })
        .map((p) => buildContradiction(p, 'Directive priority >= 7 conflicts with a completed outcome on the same repo.'));
    }

    const contradictions: Contradiction[] = [];

    // Run Flash pair-pass on all candidate pairs (already capped at 5).
    const results = await Promise.all(
      pairs.map(async (pair) => ({
        pair,
        result: await callFlashContradictionCheck(pair.directive, pair.outcome, apiKey),
      })),
    );

    for (const { pair, result } of results) {
      if (!result) continue;
      if (!result.contradicts) continue;
      if (!result.summary.trim()) continue;
      contradictions.push(buildContradiction(pair, result.summary));
    }

    return contradictions;
  } catch (err) {
    console.warn('[qa][contradictions] detector error:', err instanceof Error ? err.message : err);
    return [];
  }
}

function buildContradiction(pair: CandidatePair, summary: string): Contradiction {
  const oFields = pair.outcome.fields as Record<string, unknown>;
  const prNumber = typeof oFields.prNumber === 'number' ? oFields.prNumber : undefined;

  return {
    directiveId: pair.directive.citation.rowId,
    outcomeId: pair.outcome.citation.rowId,
    prNumber,
    summary,
  };
}
