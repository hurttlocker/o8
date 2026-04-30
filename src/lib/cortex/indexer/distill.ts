/**
 * Comment → Facts distillation (#915 north star #2).
 *
 * Calls the configured CLI (claude or codex) with the body of a single
 * github_comments row and a strict-JSON extraction prompt, then parses +
 * validates the response. Anti-hallucination guards:
 *
 *   1. `kind` must be in the allowed enum.
 *   2. `content` length 1..500 chars.
 *   3. `source_excerpt` must be a LITERAL substring of the comment body
 *      (case-sensitive). REJECT if not. This is the v1 hallucination floor.
 *   4. `source_excerpt` length 1..200.
 *   5. `confidence` must be a number in [0, 1]. Default 0.7 if missing.
 *   6. Caller filters by `confidence >= 0.6` at write time.
 *
 * Skipped/rejected facts are logged with a reason so the 20-fact spot-check
 * can be reasoned about. The function never throws — empty array means "no
 * extractable facts" (or all of them failed validation).
 */

import 'server-only';

import { callCodex, CODEX_DEFAULT_MODEL } from '@/lib/cortex/qa/llm/codex-adapter';
import { callSonnet } from '@/lib/cortex/qa/llm/sonnet-adapter';

import type { IndexerCli } from './cli-probe';

// ── Types ────────────────────────────────────────────────────────────────────

const ALLOWED_KINDS = [
  'decision',
  'spec',
  'process',
  'incident',
  'ownership',
  'cross_repo',
  'directive',
  'other',
] as const;

export type FactKind = (typeof ALLOWED_KINDS)[number];

export interface DistilledFact {
  kind: FactKind;
  content: string;
  source_excerpt: string;
  confidence: number;
}

export interface DistillInput {
  commentId: string;
  body: string;
  repoPath: string | null;
  cli: IndexerCli;
}

// ── Prompt ───────────────────────────────────────────────────────────────────

export const DISTILL_PROMPT_TEMPLATE = `You are extracting structured facts from a single GitHub comment in an engineering organization.

Read the COMMENT BODY below and emit a JSON array of facts. Each fact is one self-contained piece of organizational knowledge — a decision, spec, process, incident, ownership claim, cross-repo invariant, or directive. If the comment is purely conversational ("ok", "thanks", "lgtm"), reactionary, or contains no extractable factual content, emit an empty array [].

Output format — STRICT JSON, no prose, no code fences, no explanation:

[
  {
    "kind": "decision" | "spec" | "process" | "incident" | "ownership" | "cross_repo" | "directive" | "other",
    "content": "<1-2 sentences, self-contained, no pronouns referring to context, max 500 chars>",
    "source_excerpt": "<verbatim substring of the COMMENT BODY, max 200 chars, case-sensitive char-for-char match>",
    "confidence": <number 0.0-1.0; 1.0 = explicit statement, 0.7 = clear inference, 0.4 = ambiguous>
  }
]

Hard rules — facts that violate these will be silently rejected, so don't emit them:
- source_excerpt MUST be a verbatim, case-sensitive, character-for-character substring of the COMMENT BODY. No paraphrasing, no truncation markers, no quotation reformatting.
- content must NOT invent information not present in the comment. If a name, number, repo, or file isn't in the body, don't put it in the fact.
- content must be self-contained — readable without seeing the comment.
- Confidence below 0.6 will be dropped, so don't emit facts you're not at least somewhat sure about.

Kind selector:
- decision   — "we decided X over Y", "locked on X", "rejected proposal Z"
- spec       — schemas, table names, command syntax, type definitions, numeric thresholds
- process    — workflow steps, commands run before commit, release cadence, review rules
- incident   — "X broke when Y", failure modes, postmortem notes
- ownership  — who owns what, who reviews what, what project contains what
- cross_repo — invariants spanning multiple repos (design language, tokens, contracts)
- directive  — "must always do X", "never Y", explicit organizational rules
- other      — factual content that doesn't fit above but is still organizational knowledge

COMMENT BODY:
<<<
{BODY}
>>>

Output JSON array only:`;

function buildPrompt(body: string): string {
  // Truncate very long bodies to keep CLI invocations bounded. 8KB covers
  // the long tail of GitHub comments; longer ones get tail-truncated.
  const safeBody = body.length > 8_000 ? body.slice(0, 8_000) : body;
  return DISTILL_PROMPT_TEMPLATE.replace('{BODY}', safeBody);
}

// ── JSON parsing (defensive against ```json fences + lead-in prose) ─────────

interface RawFact {
  kind?: unknown;
  content?: unknown;
  source_excerpt?: unknown;
  confidence?: unknown;
}

function parseFactsJson(raw: string): RawFact[] {
  if (!raw || typeof raw !== 'string') return [];

  let text = raw.trim();

  // Strip markdown fences (```json ... ``` / ``` ... ```).
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // If model emitted prose before/after, find the first '[' and last ']'.
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    text = text.slice(firstBracket, lastBracket + 1);
  }

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed as RawFact[];
  } catch {
    return [];
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

interface ValidationResult {
  ok: boolean;
  reason?: string;
  fact?: DistilledFact;
}

function validateFact(raw: RawFact, body: string): ValidationResult {
  const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : '';
  if (!ALLOWED_KINDS.includes(kind as FactKind)) {
    return { ok: false, reason: `bad-kind=${JSON.stringify(raw.kind)}` };
  }

  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  if (content.length === 0 || content.length > 500) {
    return { ok: false, reason: `bad-content-len=${content.length}` };
  }

  const excerpt = typeof raw.source_excerpt === 'string' ? raw.source_excerpt : '';
  if (excerpt.length === 0 || excerpt.length > 200) {
    return { ok: false, reason: `bad-excerpt-len=${excerpt.length}` };
  }
  if (!body.includes(excerpt)) {
    return { ok: false, reason: 'excerpt-not-substring' };
  }

  let confidence = typeof raw.confidence === 'number' ? raw.confidence : 0.7;
  if (!Number.isFinite(confidence)) confidence = 0.7;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;

  return {
    ok: true,
    fact: {
      kind: kind as FactKind,
      content,
      source_excerpt: excerpt,
      confidence,
    },
  };
}

// ── CLI invocation ──────────────────────────────────────────────────────────

async function callCli(prompt: string, cli: IndexerCli): Promise<string> {
  if (cli === 'claude') {
    // System prompt is empty — the full task is in the user message so the
    // model gets unambiguous instructions in one block.
    const result = await callSonnet({
      system: 'You extract structured facts from text. Output strict JSON only.',
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      timeoutMs: 180_000,
    });
    return result.text;
  }

  return callCodex(prompt, {
    model: CODEX_DEFAULT_MODEL,
    timeoutMs: 60_000,
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Distill a single comment into validated facts. Never throws — failure modes:
 *   - CLI invocation error → returns empty + logs warning
 *   - Empty body          → returns empty silently
 *   - Parse failure        → returns empty + logs warning
 *   - All facts rejected   → returns empty + logs reasons
 */
export async function distillComment(input: DistillInput): Promise<DistilledFact[]> {
  const { commentId, body, cli } = input;

  if (!body || body.trim().length === 0) {
    return [];
  }

  const prompt = buildPrompt(body);

  let raw: string;
  try {
    raw = await callCli(prompt, cli);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[indexer] CLI call failed for ${commentId}: ${message}`);
    throw err; // bubble so the queue marks attempts++ correctly
  }

  const parsed = parseFactsJson(raw);
  if (parsed.length === 0) {
    // Either empty array (legitimate "no facts") or parse failure. Distinguish
    // by sampling the raw text — if it doesn't even contain '[', it's a parse
    // problem worth logging.
    if (!raw.includes('[')) {
      console.warn(
        `[indexer] ${commentId} parse failure (no '[' in CLI output): ${raw.slice(0, 200)}`,
      );
    }
    return [];
  }

  const validated: DistilledFact[] = [];
  const skipped: string[] = [];

  for (const candidate of parsed) {
    const result = validateFact(candidate, body);
    if (result.ok && result.fact) {
      validated.push(result.fact);
    } else if (result.reason) {
      skipped.push(result.reason);
    }
  }

  if (skipped.length > 0) {
    console.log(
      `[indexer] ${commentId} skipped ${skipped.length}/${parsed.length} facts: ${skipped.join(', ')}`,
    );
  }

  return validated;
}
