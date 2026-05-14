/**
 * Question classifier for the Cortex Q&A composer (epic #915 sub-2,
 * provider chain rewired in path-to-70 phase 1.7 v2).
 *
 * Five-tier provider chain — all return the same { class, bm25Variants } shape:
 *   1. Claude Haiku CLI       (free for Claude Max users — primary)
 *   2. Codex CLI (gpt-5.5)    (free for ChatGPT Plus / Codex sub users)
 *   3. OpenRouter (grok-4.1-fast + flash-lite + gpt-5.4-nano fallback) — paid HTTP
 *   4. Gemini Flash JSON-mode (last LLM tier; demoted because of recent 503s)
 *   5. Heuristic fallback     (lexical "why/how/explain" → Class B)
 *
 * Latency tradeoff is intentional: tiers 1 + 2 are ~15s each but FREE for
 * users with the corresponding subscription. Two free paths beat one fast
 * paid path. OpenRouter (~1s) is the safety net when neither sub is active.
 *
 * Class A = lookup: "who/when/where/what" — expects a 1-2 fact answer
 * Class B = reasoning: "why/how/explain" — expects multi-fact composition
 *
 * BM25 variants are passed directly to `retrieveAll()` so the FTS5 retriever
 * can search with synonym/phrasing expansion.
 */

import 'server-only';

import { CODEX_DEFAULT_MODEL, callCodex } from '@/lib/cortex/qa/llm/codex-adapter';
import { callHaiku } from '@/lib/cortex/qa/llm/haiku-adapter';
import { callOpenRouter, OPENROUTER_PRIMARY_MODEL } from '@/lib/cortex/qa/llm/openrouter-adapter';

export type QuestionClass = 'A' | 'B';

export interface ClassifierResult {
  class: QuestionClass;
  bm25Variants: string[];
}

const CLASSIFIER_PROMPT = `Classify the engineering question. Return ONLY a single JSON object — no prose, no markdown fences, no \`\`\` blocks, no commentary before or after.
The very first character of your response MUST be \`{\` and the last MUST be \`}\`.
Output exactly: { "class": "A" | "B", "bm25_variants": ["v1","v2","v3"] }
Class A = lookup ("who/when/where/what"), 1-2 fact answer, deterministic
Class B = reasoning ("why/how/explain"), multi-fact composition required
bm25_variants: 3-5 alternate phrasings using synonyms and rephrasings of the question`;

/**
 * Classify the question with a 5-tier provider chain:
 *   1. Claude Haiku CLI (Claude Max subscription — no per-token cost, primary)
 *   2. Codex CLI gpt-5.5 (ChatGPT Plus / Codex subscription — also free)
 *   3. OpenRouter (grok-4.1-fast w/ flash-lite + gpt-5.4-nano fallback) — paid HTTP
 *   4. Gemini Flash (JSON-mode; demoted because of recent 503s)
 *   5. Heuristic fallback (lexical "why/how/explain" → Class B)
 *
 * Returns the classification + BM25 variants. Never throws; on full failure
 * returns the heuristic Class B so retrieval still gets at least one variant.
 */
export async function classifyQuestion(question: string): Promise<ClassifierResult> {
  const prompt = `${CLASSIFIER_PROMPT}\n\nQuestion: ${question}`;
  // O8_EVAL_MODE=1 skips CLI tiers (their bootstrap dominates eval wall time)
  // and routes to anthropic/claude-haiku-4-5 via OpenRouter — same intelligence
  // tier as the local Haiku CLI users get in production.
  const evalMode = process.env.O8_EVAL_MODE === '1' || process.env.O8_EVAL_MODE === 'true';

  // Eval-mode tier 0: Sonnet 4.6 via OpenRouter — matches the composer's
  // primary model so classifier + composer use the same reasoning quality.
  // BM25 variants from Sonnet are reliably better than grok-4.1-fast.
  if (evalMode) {
    const sonnetResult = await tryOpenRouter(prompt, question, 'anthropic/claude-sonnet-4-6');
    if (sonnetResult) {
      console.info('[qa][classifier] resolved via openrouter:anthropic/claude-sonnet-4-6');
      return sonnetResult;
    }
    // Eval-mode tier 0b: Haiku 4.5 via OpenRouter as cheap fallback before grok.
    const haikuOpenrouterResult = await tryOpenRouter(prompt, question, 'anthropic/claude-haiku-4-5');
    if (haikuOpenrouterResult) {
      console.info('[qa][classifier] resolved via openrouter:anthropic/claude-haiku-4-5 (sonnet-fallback)');
      return haikuOpenrouterResult;
    }
  }

  // Tier ordering depends on the in-app orchestrator toggle (epic #1044):
  //   - toggle OFF (default) → Codex is effective tier 1, Haiku is skipped
  //     (it would throw anyway, no point burning the fast-throw cycle).
  //   - toggle ON              → Haiku tier 1, Codex tier 2 (legacy order).
  let inAppOrchestratorOn = false;
  if (!evalMode) {
    try {
      const { resolveInAppOrchestratorEnabledSync } = await import('@/lib/operator/defaults');
      inAppOrchestratorOn = resolveInAppOrchestratorEnabledSync();
    } catch {
      inAppOrchestratorOn = false;
    }
  }

  // Tier 1 (when toggle ON): Haiku CLI — free for Claude Max users. Skipped in
  // eval mode or when the toggle is OFF (Codex takes the lead slot instead).
  if (!evalMode && inAppOrchestratorOn) {
    const haikuResult = await tryHaiku(prompt, question);
    if (haikuResult) {
      console.info('[qa][classifier] resolved via haiku-cli (tier 1)');
      return haikuResult;
    }
  }

  // Tier 1 (when toggle OFF — default) / Tier 2 (when toggle ON): Codex CLI
  // — free for ChatGPT Plus / Codex sub users. Always tried when not eval-mode.
  if (!evalMode) {
    const codexResult = await tryCodex(prompt, question);
    if (codexResult) {
      console.info(
        `[qa][classifier] resolved via codex-cli:${CODEX_DEFAULT_MODEL} (${inAppOrchestratorOn ? 'tier 2' : 'tier 1 default'})`,
      );
      return codexResult;
    }
  }

  // Tier 3: OpenRouter (fast, paid — safety net when both CLIs unavailable).
  const openrouterResult = await tryOpenRouter(prompt, question);
  if (openrouterResult) {
    console.info(`[qa][classifier] resolved via openrouter:${OPENROUTER_PRIMARY_MODEL}`);
    return openrouterResult;
  }

  // Tier 4: Flash (when a Google AI key is present).
  const apiKey = process.env.GOOGLE_AI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY;
  if (apiKey) {
    const flashResult = await tryFlash(question, apiKey);
    if (flashResult) {
      console.info('[qa][classifier] resolved via flash');
      return flashResult;
    }
  }

  // Tier 5: heuristic.
  console.info('[qa][classifier] resolved via heuristic');
  return fallback(question);
}

/** Tier 1: Haiku CLI. Returns null on any failure so caller can chain. */
async function tryHaiku(prompt: string, question: string): Promise<ClassifierResult | null> {
  try {
    // 12s — Haiku CLI bootstrap (login-shell + node start) takes ~6-8s before
    // the model even runs. This is the primary tier so the longer ceiling
    // is worth it; Codex CLI / OpenRouter / Flash are the fallbacks.
    const text = await callHaiku(prompt, { timeoutMs: 12_000 });
    return parseClassifierJson(text, question);
  } catch (err) {
    console.warn('[qa][classifier] Haiku CLI failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Tier 2: Codex CLI. Free for ChatGPT Plus / Codex sub users. */
async function tryCodex(prompt: string, question: string): Promise<ClassifierResult | null> {
  try {
    // 30s — Codex bootstrap is ~15s for trivial prompts (verified live with gpt-5.5).
    // Larger ceiling than Haiku because the model takes longer to reason.
    const text = await callCodex(prompt, { timeoutMs: 30_000 });
    return parseClassifierJson(text, question);
  } catch (err) {
    console.warn('[qa][classifier] Codex CLI failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Tier 3: OpenRouter. HTTP call to grok-4.1-fast with flash-lite + gpt-5.4-nano in-call fallback.
 * Optional `model` override routes to a specific model instead of the primary
 * (used by the eval-mode Haiku-4.5 tier). */
async function tryOpenRouter(prompt: string, question: string, model?: string): Promise<ClassifierResult | null> {
  try {
    // 25s — bumped from 10s alongside composer's bump to handle multi-row
    // prompts under load. Classifier prompts are small but grok-4.1-fast
    // occasionally takes 8-12s when OpenRouter routes through a slow upstream.
    const text = await callOpenRouter(prompt, { timeoutMs: 25_000, model });
    return parseClassifierJson(text, question);
  } catch (err) {
    console.warn('[qa][classifier] OpenRouter failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Tier 4: Flash JSON-mode call. Returns null on any failure so caller can chain. */
async function tryFlash(question: string, apiKey: string): Promise<ClassifierResult | null> {
  try {
    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `${CLASSIFIER_PROMPT}\n\nQuestion: ${question}`,
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0,
        maxOutputTokens: 256,
      },
    };

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      },
    );

    if (!res.ok) {
      console.warn(`[qa][classifier] Flash API error ${res.status} — falling through to heuristic`);
      return null;
    }

    const json = await res.json() as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!rawText.trim()) return null;

    return parseClassifierJson(rawText, question);
  } catch (err) {
    console.warn('[qa][classifier] Flash threw:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Parse a classifier JSON response (any tier).
 *
 * CLI-backed providers (Haiku, Codex, OpenRouter) sometimes wrap JSON in
 * markdown fences or sandwich it between preamble/postamble prose despite
 * being told not to. The parser tries, in order:
 *   1. closed ```json ... ``` block
 *   2. unclosed ```json ... (no trailing fence — Codex sometimes does this)
 *   3. greedy { ... } match anywhere in the response
 *
 * Returns null if the payload still can't be coerced — caller falls through.
 */
function parseClassifierJson(rawText: string, question: string): ClassifierResult | null {
  let text = rawText.trim();

  // 1. Closed code fence — ```json {...} ``` or ``` {...} ```
  const closedFence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (closedFence) {
    text = closedFence[1].trim();
  } else {
    // 2. Unclosed fence — Codex sometimes drops the trailing ```
    const openFence = text.match(/```(?:json)?\s*([\s\S]*)$/i);
    if (openFence) {
      text = openFence[1].trim();
    }
    // 3. Extract first {...} (handles preamble + postamble prose)
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
      text = objMatch[0].trim();
    }
  }

  let parsed: { class?: unknown; bm25_variants?: unknown };
  try {
    parsed = JSON.parse(text) as { class?: unknown; bm25_variants?: unknown };
  } catch {
    return null;
  }

  const cls: QuestionClass = parsed.class === 'A' ? 'A' : 'B';
  const variants = Array.isArray(parsed.bm25_variants)
    ? (parsed.bm25_variants as unknown[])
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .slice(0, 5)
    : [];

  return {
    class: cls,
    bm25Variants: variants.length > 0 ? variants : [question],
  };
}

/** Safe fallback when all LLM tiers are unavailable or return garbage. */
function fallback(question: string): ClassifierResult {
  // Heuristic: questions starting with "why" / "how" / "explain" → Class B.
  const lower = question.trim().toLowerCase();
  const cls: QuestionClass =
    lower.startsWith('why') || lower.startsWith('how') || lower.startsWith('explain')
      ? 'B'
      : 'A';
  return { class: cls, bm25Variants: [question] };
}
