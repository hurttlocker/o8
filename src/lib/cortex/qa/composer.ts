/**
 * Q&A LLM composer (epic #915 sub-2).
 *
 * Two compose paths based on the Flash classifier's output:
 *   - Class A (lookup): Gemini Flash JSON — 200-500ms, one-sentence answer
 *   - Class B (reasoning): Claude Sonnet streaming — 1-3s TTFT, cited paragraphs
 *
 * Citation discipline:
 *   After the LLM finishes, we parse `[BRACKET-ID]` style markers from the
 *   answer and translate them into `[CITATION:<kind>-<rowId>]` markers that
 *   the AnswerStream component already knows how to splice into CitationPills.
 *   Any citation whose rowId cannot be found in topRows is DROPPED (anti-hallucination).
 *
 * SSE frame format emitted:
 *   event: token      { text: string }
 *   event: citation   { kind, rowId, table, excerpt?, url? }
 *   event: done       {}
 *   event: error      { message: string }
 */

import 'server-only';

import { detectContradictions } from '@/lib/cortex/qa/contradictions';
import { callHaiku } from '@/lib/cortex/qa/llm/haiku-adapter';
import { callSonnet } from '@/lib/cortex/qa/llm/sonnet-adapter';
import type { TypedRow } from '@/lib/cortex/qa/types';

// ── Prompts ───────────────────────────────────────────────────────────────────

function buildFlashComposePrompt(question: string, rowsJson: string): string {
  return `Answer concisely (one sentence) using ONLY the provided typed rows.
Question: ${question}
Rows: ${rowsJson}
Cite the relevant row in [BRACKET-ID] form where BRACKET-ID is the citation handle from the row (e.g. [D-014], [O-481], [PR-650]).
If no rows answer the question, say: "I don't have that information yet."`;
}

function buildSonnetComposeSystem(): string {
  return `You are a concise engineering assistant answering questions using ONLY provided typed rows as sources.

Rules:
1. Answer in 1-6 sentences. Be direct and specific. For multi-fact specs (latency budgets, schema/table lists, cache TTLs, configuration values, enumerated rules), enumerate EVERY relevant fact present in the rows — don't cherry-pick one and skip the rest. Single-fact questions still get a single tight sentence.
2. Cite EVERY fact using the row's citation handle in [BRACKET-ID] form (e.g. [D-014] for directives, [O-481] for outcomes, [PR-650] for PRs). One citation per fact, inline.
3. Ground every claim in the retrieved rows. Do not invent facts, numbers, or names not present in the rows.
4. If rows don't answer the question, say exactly: "I don't have that information yet — try indexing more directives or PRs."
5. Stream your answer token by token.`;
}

function buildSonnetComposeUser(
  question: string,
  repoPath: string | undefined,
  rows: TypedRow[],
): string {
  const rowsJson = JSON.stringify(
    rows.slice(0, 20).map((r) => ({
      citationHandle: buildCitationHandle(r),
      kind: r.citation.kind,
      excerpt: r.citation.excerpt ?? '',
      fields: r.fields,
    })),
    null,
    2,
  );

  const repoLine = repoPath ? `\nRepo: ${repoPath}` : '';
  return `Question: ${question}${repoLine}\n\nAvailable rows:\n${rowsJson}`;
}

/** Build the citation handle an LLM would use in bracket notation. */
function buildCitationHandle(row: TypedRow): string {
  const { kind, rowId } = row.citation;
  switch (kind) {
    case 'directive':
      return `D-${rowId}`;
    case 'outcome':
      return `O-${rowId}`;
    case 'pr':
      return `PR-${rowId}`;
    case 'issue':
      return `ISS-${rowId}`;
    case 'symbol':
      return `SYM-${rowId}`;
    case 'project':
      return `PROJ-${rowId}`;
    case 'project_repo':
      // PRJREPO- prefix avoids collision with PR- (pull requests).
      return `PRJREPO-${rowId}`;
    default:
      return rowId;
  }
}

// ── Citation parsing + verification ──────────────────────────────────────────

/**
 * Map of bracket handle → TypedRow, built from the topRows the retriever
 * returned. Only handles that exist in this map are accepted into the answer.
 */
function buildCitationLookup(rows: TypedRow[]): Map<string, TypedRow> {
  const map = new Map<string, TypedRow>();
  for (const row of rows) {
    const handle = buildCitationHandle(row).toUpperCase();
    map.set(handle, row);
    // Also index on bare rowId (e.g. "481" → outcome row) for flexibility.
    map.set(row.citation.rowId.toUpperCase(), row);
  }
  return map;
}

/**
 * Parse bracket citations like [D-014], [O-481], [PR-650] from an LLM answer.
 * Returns the set of handles found (uppercased).
 */
function parseBracketHandles(answer: string): string[] {
  const re = /\[([A-Z0-9_\-#.]+)\]/gi;
  const handles: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    handles.push(m[1].toUpperCase());
  }
  return [...new Set(handles)];
}

/**
 * Translate `[BRACKET-ID]` markers in the answer to `[CITATION:<kind>-<rowId>]`
 * format that AnswerStream expects. Drops any handle not in the lookup
 * (anti-hallucination).
 */
function translateCitations(answer: string, lookup: Map<string, TypedRow>): {
  translatedAnswer: string;
  verifiedRows: TypedRow[];
} {
  const verifiedSet = new Set<string>();
  const verifiedRows: TypedRow[] = [];

  const translated = answer.replace(/\[([A-Z0-9_\-#.]+)\]/gi, (match, handle) => {
    const row = lookup.get(handle.toUpperCase());
    if (!row) {
      // Unverified citation — drop it (return empty string so no stray text leaks).
      return '';
    }
    const key = `${row.citation.kind}:${row.citation.rowId}`;
    if (!verifiedSet.has(key)) {
      verifiedSet.add(key);
      verifiedRows.push(row);
    }
    return `[CITATION:${row.citation.kind}-${row.citation.rowId}]`;
  });

  return { translatedAnswer: translated.trim(), verifiedRows };
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

function sseFrame(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export type SseEmit = (name: string, payload: unknown) => void;

// ── Class A composer (Flash → Haiku CLI → Sonnet CLI → heuristic) ────────────

/**
 * Class A compose chain:
 *   1. Flash       — fast (200-500ms) JSON answer when Google AI key + service available
 *   2. Haiku CLI   — falls in when Flash 503s / errors. Claude Max subscription, no token cost.
 *   3. Sonnet CLI  — last LLM tier; slower (5-12s) but reuses the same CLI plumbing.
 *   4. Heuristic   — final fallback when all LLMs are unavailable.
 *
 * Each tier returns a raw answer string (or null on failure). After we get
 * an answer, we translate bracket citations → CITATION markers, emit tokens
 * and verified citations, then `done`. The path that resolved is logged so
 * we can track tier health in production.
 */
export async function composeClassA(
  question: string,
  repoPath: string | undefined,
  topRows: TypedRow[],
  emit: SseEmit,
): Promise<void> {
  const lookup = buildCitationLookup(topRows);
  const rowsJson = JSON.stringify(
    topRows.slice(0, 15).map((r) => ({
      handle: buildCitationHandle(r),
      excerpt: r.citation.excerpt ?? '',
    })),
  );
  const flashPrompt = buildFlashComposePrompt(question, rowsJson);

  // Tier 1: Flash.
  const flashAnswer = await tryComposeFlash(flashPrompt);
  if (flashAnswer) {
    console.info('[qa][composer-A] resolved via flash');
    emitClassAAnswer(flashAnswer, lookup, emit);
    return;
  }

  // Tier 2: Haiku CLI.
  const haikuAnswer = await tryComposeHaiku(flashPrompt);
  if (haikuAnswer) {
    console.info('[qa][composer-A] resolved via haiku-cli');
    emitClassAAnswer(haikuAnswer, lookup, emit);
    return;
  }

  // Tier 3: Sonnet CLI (callSonnet's CLI tier — slow but reliable).
  const sonnetAnswer = await tryComposeSonnet(question, repoPath, topRows);
  if (sonnetAnswer) {
    console.info('[qa][composer-A] resolved via sonnet-cli');
    emitClassAAnswer(sonnetAnswer, lookup, emit);
    return;
  }

  // Tier 4: heuristic.
  console.info('[qa][composer-A] resolved via heuristic');
  emit('token', { text: 'I don\'t have that information yet.' });
  emit('done', {});
}

/** Tier 1: Flash. Returns answer text or null on any failure. */
async function tryComposeFlash(prompt: string): Promise<string | null> {
  const apiKey =
    process.env.GOOGLE_AI_API_KEY ??
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 300 },
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`[qa][composer-A] Flash error ${res.status}: ${errText.slice(0, 200)} — trying Haiku CLI`);
      return null;
    }

    const json = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return text.trim() ? text : null;
  } catch (err) {
    console.warn('[qa][composer-A] Flash threw:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Tier 2: Haiku CLI. Same prompt shape as Flash. */
async function tryComposeHaiku(prompt: string): Promise<string | null> {
  try {
    // 12s — Haiku CLI bootstrap (login-shell + node start) takes ~6-8s before
    // the model even runs. Flash already had its 8s shot above; this is the
    // slower fallback so a slightly-longer ceiling is fine.
    const text = await callHaiku(prompt, { timeoutMs: 12_000 });
    return text.trim() ? text : null;
  } catch (err) {
    console.warn('[qa][composer-A] Haiku CLI failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Tier 3: Sonnet CLI via callSonnet (non-streaming).
 *
 * Reuses Class B's prompt shape (system + user) since Sonnet works best
 * with the structured rows JSON. We only fall here when both Flash and
 * Haiku failed, so the slower latency is acceptable.
 *
 * Returns null when callSonnet itself errors OR when the resolved tier is
 * Flash (we already tried Flash in tier 1 — no point looping back).
 */
async function tryComposeSonnet(
  question: string,
  repoPath: string | undefined,
  topRows: TypedRow[],
): Promise<string | null> {
  try {
    const result = await callSonnet({
      system: buildSonnetComposeSystem(),
      messages: [
        {
          role: 'user',
          content: buildSonnetComposeUser(question, repoPath, topRows),
        },
      ],
      stream: false,
    });
    if (result.tier === 'flash') {
      // callSonnet degraded back to Flash; we already tried Flash in tier 1.
      return null;
    }
    return result.text.trim() ? result.text : null;
  } catch (err) {
    console.warn('[qa][composer-A] Sonnet CLI failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Translate bracket citations, emit token + citations + done. Shared by all
 * three LLM tiers so the SSE shape stays identical regardless of which
 * provider answered.
 */
function emitClassAAnswer(rawAnswer: string, lookup: Map<string, TypedRow>, emit: SseEmit): void {
  const { translatedAnswer, verifiedRows } = translateCitations(rawAnswer, lookup);
  emit('token', { text: translatedAnswer });
  for (const row of verifiedRows) {
    emit('citation', {
      kind: row.citation.kind,
      rowId: `${row.citation.kind}-${row.citation.rowId}`,
      table: row.citation.table,
      excerpt: row.citation.excerpt,
      url: row.citation.url,
    });
  }
  emit('done', {});
}

// ── Class B composer (Sonnet via CLI > API > Flash) ──────────────────────────

export async function composeClassB(
  question: string,
  repoPath: string | undefined,
  topRows: TypedRow[],
  emit: SseEmit,
): Promise<void> {
  const lookup = buildCitationLookup(topRows);

  try {
    const result = await callSonnet({
      system: buildSonnetComposeSystem(),
      messages: [
        {
          role: 'user',
          content: buildSonnetComposeUser(question, repoPath, topRows),
        },
      ],
      stream: true,
    });

    // Consume the token stream, emitting each token and accumulating for
    // citation post-processing. Works for all three tiers (cli/api/flash).
    let fullText = '';
    for await (const token of result.tokens) {
      if (!token) continue;
      fullText += token;
      emit('token', { text: token });
    }

    // Post-process: translate bracket citations → verified CITATION markers.
    let finalAnswer = '';
    if (fullText.trim()) {
      const { translatedAnswer: translated, verifiedRows } = translateCitations(fullText, lookup);
      finalAnswer = translated;
      for (const row of verifiedRows) {
        emit('citation', {
          kind: row.citation.kind,
          rowId: `${row.citation.kind}-${row.citation.rowId}`,
          table: row.citation.table,
          excerpt: row.citation.excerpt,
          url: row.citation.url,
        });
      }
    } else {
      // Nothing streamed — emit a default message.
      emit('token', { text: 'I don\'t have that information yet — try indexing more directives or PRs.' });
    }

    // Contradiction pass — runs after the answer streams (non-blocking to TTFT).
    const contradictions = await detectContradictions({ rows: topRows, answer: finalAnswer });
    for (const c of contradictions) {
      emit('contradiction', c);
    }

    emit('done', {});
  } catch (err) {
    const message = err instanceof Error ? err.message : 'composer-B error';
    console.warn('[qa][composer-B] error:', message);
    // Degrade to Flash on any failure.
    return composeClassA(question, repoPath, topRows, emit);
  }
}
