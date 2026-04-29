/**
 * Flash classifier for the Cortex Q&A composer (epic #915 sub-2).
 *
 * One Gemini Flash JSON-mode call to:
 *   - Classify the question as Class A (lookup) or Class B (reasoning)
 *   - Generate 3-5 BM25 query variants for the retrieval layer
 *
 * Class A = lookup: "who/when/where/what" — expects a 1-2 fact answer
 * Class B = reasoning: "why/how/explain" — expects multi-fact composition
 *
 * The BM25 variants are passed directly to `retrieveAll()` as `bm25Variants`
 * so the FTS5 retriever can search with synonym/phrasing expansion.
 *
 * Target latency: 50ms p50 / 200ms p95 (Flash is fast; JSON-mode is cheap).
 */

import 'server-only';

export type QuestionClass = 'A' | 'B';

export interface ClassifierResult {
  class: QuestionClass;
  bm25Variants: string[];
}

const CLASSIFIER_PROMPT = `Classify the engineering question. Return ONLY strict JSON, no other text.
Output format: { "class": "A" | "B", "bm25_variants": ["v1","v2","v3"] }
Class A = lookup ("who/when/where/what"), 1-2 fact answer, deterministic
Class B = reasoning ("why/how/explain"), multi-fact composition required
bm25_variants: 3-5 alternate phrasings using synonyms and rephrasings of the question`;

/**
 * Call Gemini Flash in JSON mode to classify the question.
 * Falls back to Class B (safer: prefers Sonnet compose) on any error.
 */
export async function classifyQuestion(question: string): Promise<ClassifierResult> {
  const apiKey = process.env.GOOGLE_AI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // No key — default to Class B so we always use the Anthropic path if available.
    return fallback(question);
  }

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
      console.warn(`[qa][classifier] Flash API error ${res.status} — defaulting to Class B`);
      return fallback(question);
    }

    const json = await res.json() as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!rawText.trim()) {
      return fallback(question);
    }

    // Strip any preamble text and markdown code fences.
    // Flash sometimes returns "Here is the JSON:\n```json\n{...}\n```"
    let text = rawText.trim();
    // Extract JSON from inside a code fence if present.
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenceMatch) {
      text = fenceMatch[1].trim();
    } else {
      // Try to extract the first JSON object directly from the text.
      const objMatch = text.match(/\{[\s\S]*\}/);
      if (objMatch) {
        text = objMatch[0].trim();
      }
    }

    let parsed: { class?: unknown; bm25_variants?: unknown };
    try {
      parsed = JSON.parse(text) as { class?: unknown; bm25_variants?: unknown };
    } catch {
      // Flash returned non-JSON even after extraction — use heuristic fallback.
      // This is common when the model adds explanatory prose despite JSON-mode.
      console.info('[qa][classifier] Non-JSON Flash response after extraction — using heuristic fallback');
      return fallback(question);
    }

    const cls = parsed.class === 'A' ? 'A' : 'B';
    const variants = Array.isArray(parsed.bm25_variants)
      ? (parsed.bm25_variants as unknown[])
          .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
          .slice(0, 5)
      : [];

    return {
      class: cls,
      bm25Variants: variants.length > 0 ? variants : [question],
    };
  } catch (err) {
    console.warn('[qa][classifier] error:', err instanceof Error ? err.message : err);
    return fallback(question);
  }
}

/** Safe fallback when Flash is unavailable or returns garbage. */
function fallback(question: string): ClassifierResult {
  // Heuristic: questions starting with "why" / "how" / "explain" → Class B.
  const lower = question.trim().toLowerCase();
  const cls: QuestionClass =
    lower.startsWith('why') || lower.startsWith('how') || lower.startsWith('explain')
      ? 'B'
      : 'A';
  return { class: cls, bm25Variants: [question] };
}
