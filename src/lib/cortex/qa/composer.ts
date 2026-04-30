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
import { CODEX_DEFAULT_MODEL, callCodex } from '@/lib/cortex/qa/llm/codex-adapter';
import { callHaiku } from '@/lib/cortex/qa/llm/haiku-adapter';
import { isByokRequired } from '@/lib/cortex/qa/llm/byok-keys';
import { callOpenRouter, OPENROUTER_PRIMARY_MODEL } from '@/lib/cortex/qa/llm/openrouter-adapter';
import { callSonnet } from '@/lib/cortex/qa/llm/sonnet-adapter';
import type { TypedRow } from '@/lib/cortex/qa/types';

// ── Prompts ───────────────────────────────────────────────────────────────────

function buildFlashComposePrompt(question: string, rowsJson: string): string {
  return `Answer concisely (1-2 sentences) using ONLY the provided typed rows.
Question: ${question}
Rows (each row has a \`handle\` for citation, \`content\` with the actual text, and \`source_authority\` 0-1): ${rowsJson}

Rules:
1. If ANY row's content addresses the question — fully or partially — lead with that information. Quote concrete values, numbers, names, and identifiers verbatim from the content. Prefer FACT- handles as primary citations.
2. Cite the relevant row(s) inline in [BRACKET-ID] form where BRACKET-ID is the handle field from the row (e.g. [D-014], [O-481], [PR-650], [FACT-abc123]).
3. Source-of-truth hierarchy: each row carries \`source_authority\` (0-1). When two rows contradict, cite the higher-authority one. Directives (1.0) are the project's rules — prefer them over comment opinions (0.7). Merged PRs (0.95) outrank open ones (0.8). Closed issues (0.85) outrank open ones (0.75).
4. NEVER hedge with "I don't have that information yet" when you ARE answering. Either answer with citations OR respond with the exact string "I don't have that information yet." and nothing else. There is no middle ground — no preambles, no apologies.
5. Only respond "I don't have that information yet." when none of the rows even mention the topic.`;
}

function buildSonnetComposeSystem(): string {
  return `You are a concise engineering assistant answering questions using ONLY provided typed rows as sources.

Rules:
1. Answer in 1-6 sentences. Be direct and specific. For multi-fact specs (latency budgets, schema/table lists, cache TTLs, configuration values, enumerated rules), enumerate EVERY relevant fact present in the rows — don't cherry-pick one and skip the rest. Single-fact questions still get a single tight sentence.
2. Cite EVERY fact using the row's citation handle in [BRACKET-ID] form (e.g. [D-014] for directives, [O-481] for outcomes, [PR-650] for PRs). One citation per fact, inline.
3. Rows with citation handle prefix \`FACT-\` are pre-extracted facts (high confidence). Prefer these as your primary citations when they answer the question. Cite raw rows (D-/O-/PR-/CMT-/DOC-) only when no FACT- row covers the fact.
4. Source-of-truth hierarchy: each row carries \`source_authority\` (0-1). When two rows contradict, cite the higher-authority one. Directives (1.0) are the project's rules — prefer them over comment opinions (0.7). Merged PRs (0.95) outrank open ones (0.8). Closed issues (0.85) outrank open ones (0.75).
5. Ground every claim in the retrieved rows. Do not invent facts, numbers, or names not present in the rows.
6. If rows don't answer the question, say exactly: "I don't have that information yet — try indexing more directives or PRs."
7. Stream your answer token by token.`;
}

function buildSonnetComposeUser(
  question: string,
  repoPath: string | undefined,
  rows: TypedRow[],
): string {
  // #915 path-to-70 round-2 fix: was slice(0, 20), but retrieve.ts merges to
  // MERGE_LIMIT = 30. Project rows from emitProjectRows landed at ranks 21-24
  // and got truncated here — ownership stayed at 35% despite PR #949 paying
  // the bill. Match the merge ceiling.
  const rowsJson = JSON.stringify(
    rows.slice(0, 30).map((r) => ({
      citationHandle: buildCitationHandle(r),
      kind: r.citation.kind,
      excerpt: r.citation.excerpt ?? '',
      // Source-of-truth hierarchy (#915 follow-up). Top-level so the model
      // doesn't have to reach into `fields` for it.
      source_authority: rowAuthority(r),
      fields: r.fields,
    })),
    null,
    2,
  );

  const repoLine = repoPath ? `\nRepo: ${repoPath}` : '';
  return `Question: ${question}${repoLine}\n\nAvailable rows:\n${rowsJson}`;
}

/**
 * Extract the longest readable text from a row's `fields` payload. Used to
 * feed the composer LLM full content instead of the BM25-truncated FTS snippet
 * (which strips the very numbers/values most questions are asking about).
 *
 * Field shapes are heterogeneous across retrievers — facts have `content`,
 * comments + directives have `body`, PRs/issues have `title` + `body`, etc.
 * We pick the most informative field per row kind, capped at ~1500 chars so
 * a single row can't crowd out the rest of the slice.
 */
function rowFullText(row: TypedRow): string {
  const fields = row.fields as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = fields?.[k];
      if (typeof v === 'string' && v.trim().length > 0) return v;
    }
    return '';
  };
  let text = '';
  switch (row.citation.kind) {
    case 'fact':
      text = pick('content');
      break;
    case 'directive':
      text = [pick('title'), pick('body')].filter(Boolean).join(' — ');
      break;
    case 'comment':
      text = pick('body');
      break;
    case 'outcome':
      text = pick('summary', 'body', 'title');
      break;
    case 'pr':
    case 'issue':
      text = [pick('title'), pick('body')].filter(Boolean).join(' — ');
      break;
    case 'doc':
      text = pick('content', 'body', 'excerpt');
      break;
    default:
      text = pick('body', 'content', 'title', 'excerpt');
  }
  if (text.length > 1500) text = text.slice(0, 1500) + '…';
  return text;
}

/**
 * Resolve the source-of-truth authority for a row (#915 follow-up).
 *
 * Fact rows carry the explicit `source_authority` field populated by the
 * worker / structured seeder / v18 backfill. Non-fact rows (raw directive,
 * outcome, PR, issue, comment hits) don't carry it, so we derive a default
 * from `citation.kind` matching the same hierarchy. State-aware tiers
 * (merged-vs-open PR, closed-vs-open issue) collapse to the lower bound
 * since the raw retrievers don't surface that state in `fields`. The
 * facts retriever path stays the canonical signal — non-fact retrievers
 * are coarser-grained on purpose.
 */
function rowAuthority(row: TypedRow): number {
  const explicit = (row.fields as Record<string, unknown>)?.source_authority;
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
  switch (row.citation.kind) {
    case 'directive':
      return 1.0;
    case 'outcome':
      return 0.9;
    case 'pr':
      return 0.8;
    case 'issue':
      return 0.75;
    case 'comment':
      return 0.7;
    case 'fact':
      // No explicit field on a fact row — legacy data pre-v18 backfill.
      // 0.5 is the column default and signals "unknown" to the LLM.
      return 0.5;
    default:
      return 0.5;
  }
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
    case 'comment':
      // CMT- prefix avoids collision with the rest. The rowId is the
      // composite `<parent_kind>-<parent_number>-<gh_comment_id>` from the
      // ingestion job.
      return `CMT-${rowId}`;
    case 'symbol':
      return `SYM-${rowId}`;
    case 'project':
      return `PROJ-${rowId}`;
    case 'project_repo':
      // PRJREPO- prefix avoids collision with PR- (pull requests).
      return `PRJREPO-${rowId}`;
    case 'doc':
      // Doc rowIds are `<repoPath>:<relPath>` — too long to embed verbatim
      // in an LLM bracket. Hash deterministically to a 10-char tag so the
      // handle stays bracket-safe and the lookup map can index both forms.
      return `DOC-${shortDocHandle(rowId)}`;
    case 'fact':
      // Engineering Brain Indexer (#915 north star #1). Fact rowIds are short
      // ULIDs/uuids so we embed verbatim — no hashing needed. FACT- prefix
      // avoids any collision with the existing handles above.
      return `FACT-${rowId}`;
    default:
      return rowId;
  }
}

/**
 * 10-char alphanumeric hash for doc citation handles. Stable for a given
 * rowId so the LLM can re-emit the same bracket and we still resolve it.
 *
 * djb2 is overkill for ~50 docs, but cheap; collision probability across
 * the realistic doc set is well below the floor of accidental hallucinations
 * the composer already filters at translation time.
 */
function shortDocHandle(rowId: string): string {
  let hash = 5381;
  for (let i = 0; i < rowId.length; i += 1) {
    hash = ((hash << 5) + hash + rowId.charCodeAt(i)) & 0xffffffff;
  }
  // base36, padded to 8+ chars by pre-pending the length-mod-9 char so the
  // tag is fixed-width and easy to spot in the answer text.
  const tail = (hash >>> 0).toString(36).padStart(7, '0').slice(-7);
  const head = (rowId.length % 36).toString(36);
  return `${head}${tail}`.toUpperCase();
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

// ── Class A composer (Haiku CLI → Codex CLI → OpenRouter → Flash → Sonnet CLI → heuristic) ──

/**
 * Class A compose chain (rewired in #915 path-to-70 phase 1.7 v2):
 *   1. Haiku CLI   — Claude Max subscription, no per-token cost. Primary.
 *   2. Codex CLI   — ChatGPT Plus / Codex subscription, also free. Two CLIs
 *                     beat one for users with either sub. ~15s vs ~14s Haiku.
 *   3. OpenRouter  — grok-4.1-fast (held in 2026-04-30 phase 1.7.1 rerun)
 *                     w/ flash-lite + gpt-5.4-nano in-call fallback. Paid HTTP, ~1-6s.
 *   4. Flash       — Google AI key. Demoted because of recent 503 churn.
 *   5. Sonnet CLI  — slow (5-12s) but reliable when everything else 503s.
 *   6. Heuristic   — final fallback when every LLM is unavailable.
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
      // Prefer the full row content over the FTS snippet — snippets are
      // truncated to ~8 tokens around the BM25 match (e.g. "A CI «regression»
      // «gate» requires that no «eval»…") and strip the very numbers/values
      // the question is asking about. Falling back to the snippet only when
      // no fuller text is available.
      content: rowFullText(r) || r.citation.excerpt || '',
      // Source-of-truth hierarchy (#915 follow-up). Composer prompt rules
      // tell the model to prefer higher-authority rows when facts conflict.
      // Default 0.5 for non-fact rows or legacy facts pre-v18 backfill.
      source_authority: rowAuthority(r),
    })),
  );
  const composePrompt = buildFlashComposePrompt(question, rowsJson);
  // O8_EVAL_MODE=1 is the ship-gate / smoke path. We use Sonnet 4.6 via
  // OpenRouter (~$0.026/run) because false negatives cost more in re-
  // investigation than the bill. Production user chat (non-eval-mode)
  // routes through Haiku CLI tier 1 — free for Claude Max users.
  const evalMode = process.env.O8_EVAL_MODE === '1' || process.env.O8_EVAL_MODE === 'true';

  // Eval-mode tier 0: Sonnet 4.6 via OpenRouter — best reasoning + synthesis,
  // never hedges when rows answer the question.
  if (evalMode) {
    const sonnetAnswer = await tryComposeOpenRouter(composePrompt, 'anthropic/claude-sonnet-4-6');
    if (sonnetAnswer) {
      console.info('[qa][composer-A] resolved via openrouter:anthropic/claude-sonnet-4-6');
      emitClassAAnswer(sonnetAnswer, lookup, emit);
      return;
    }
    // Eval-mode tier 0b: Haiku 4.5 via OpenRouter as cheap fallback before grok.
    const haikuAnswer = await tryComposeOpenRouter(composePrompt, 'anthropic/claude-haiku-4-5');
    if (haikuAnswer) {
      console.info('[qa][composer-A] resolved via openrouter:anthropic/claude-haiku-4-5 (sonnet-fallback)');
      emitClassAAnswer(haikuAnswer, lookup, emit);
      return;
    }
  }

  // Tier 1: Haiku CLI. Skipped in eval mode (CLI bootstrap exceeds smoke budget).
  if (!evalMode) {
    const haikuAnswer = await tryComposeHaiku(composePrompt);
    if (haikuAnswer) {
      console.info('[qa][composer-A] resolved via haiku-cli');
      emitClassAAnswer(haikuAnswer, lookup, emit);
      return;
    }
  }

  // Tier 2: Codex CLI. Skipped in eval mode.
  if (!evalMode) {
    const codexAnswer = await tryComposeCodex(composePrompt);
    if (codexAnswer) {
      console.info(`[qa][composer-A] resolved via codex-cli:${CODEX_DEFAULT_MODEL}`);
      emitClassAAnswer(codexAnswer, lookup, emit);
      return;
    }
  }

  // Tier 3: OpenRouter (grok-4.1-fast w/ flash-lite + gpt-5.4-nano fallback).
  const openrouterAnswer = await tryComposeOpenRouter(composePrompt);
  if (openrouterAnswer) {
    console.info(`[qa][composer-A] resolved via openrouter:${OPENROUTER_PRIMARY_MODEL}`);
    emitClassAAnswer(openrouterAnswer, lookup, emit);
    return;
  }

  // Tier 4: Flash.
  const flashAnswer = await tryComposeFlash(composePrompt);
  if (flashAnswer) {
    console.info('[qa][composer-A] resolved via flash');
    emitClassAAnswer(flashAnswer, lookup, emit);
    return;
  }

  // Tier 5: Sonnet CLI (callSonnet's CLI tier — slow but reliable). Skipped in eval mode.
  if (!evalMode) {
    const sonnetAnswer = await tryComposeSonnet(question, repoPath, topRows);
    if (sonnetAnswer) {
      console.info('[qa][composer-A] resolved via sonnet-cli');
      emitClassAAnswer(sonnetAnswer, lookup, emit);
      return;
    }
  }

  // Tier 6: heuristic.
  console.info('[qa][composer-A] resolved via heuristic');
  emit('token', { text: 'I don\'t have that information yet.' });
  emit('done', {});
}

/** Tier 1: Haiku CLI. Free for Claude Max users — primary tier. */
async function tryComposeHaiku(prompt: string): Promise<string | null> {
  try {
    // 30s — Haiku CLI bootstrap is ~6-8s, then synthesis over 30 retrieval
    // rows runs another 10-15s on big multi-row prompts. The previous 12s
    // ceiling killed every smoke composer call before generation completed,
    // forcing a fall-through to grok-4.1-fast which over-rejects the Flash
    // "no info" escape. 30s gives Haiku the room to actually answer; the
    // OpenRouter / Flash tiers below still catch true failures.
    const text = await callHaiku(prompt, { timeoutMs: 30_000 });
    return text.trim() ? text : null;
  } catch (err) {
    console.warn('[qa][composer-A] Haiku CLI failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Tier 2: Codex CLI. Free for ChatGPT Plus / Codex sub users. */
async function tryComposeCodex(prompt: string): Promise<string | null> {
  try {
    // 30s — Codex bootstrap is ~15s for trivial prompts (verified live with gpt-5.4).
    // The larger ceiling matches the slower bootstrap path; OpenRouter (~1s)
    // is the fast-path fallback below.
    const text = await callCodex(prompt, { timeoutMs: 30_000 });
    return text.trim() ? text : null;
  } catch (err) {
    console.warn('[qa][composer-A] Codex CLI failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Tier 3: OpenRouter — grok-4.1-fast with flash-lite + gpt-5.4-nano in-call fallback.
 * Optional `model` override routes to a specific model instead of the primary
 * (used by the eval-mode Haiku-4.5 tier).
 *
 * BYOK gate (#960): when O8_BYOK_REQUIRED=1 and no stored user key exists,
 * this tier is skipped so non-BYOK users don't accidentally burn the
 * founder's OpenRouter credits. Without the flag the existing behaviour is
 * preserved (smoke + dev env always resolve via process.env). */
async function tryComposeOpenRouter(prompt: string, model?: string): Promise<string | null> {
  // O8_BYOK_REQUIRED=1 + no stored key → skip tier
  if (await isByokRequired()) {
    console.info('[qa][composer-A] OpenRouter tier skipped (O8_BYOK_REQUIRED and no stored key)');
    return null;
  }
  try {
    // 25s — was 10s, but ownership questions in eval mode hit grok-4.1-fast
    // with the full 30-row payload (post-slice-fix) and timed out at 10s
    // (caused 35% → 2% ownership crash). p95 for multi-row prompts is past
    // 10s; 25s gives headroom for worst case.
    const text = await callOpenRouter(prompt, { timeoutMs: 25_000, model });
    return text.trim() ? text : null;
  } catch (err) {
    console.warn('[qa][composer-A] OpenRouter failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Tier 3: Flash. Returns answer text or null on any failure. */
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
      console.warn(`[qa][composer-A] Flash error ${res.status}: ${errText.slice(0, 200)} — trying Sonnet CLI`);
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

/**
 * Tier 5: Sonnet CLI via callSonnet (non-streaming).
 *
 * Reuses Class B's prompt shape (system + user) since Sonnet works best
 * with the structured rows JSON. We only fall here when Haiku CLI,
 * Codex CLI, OpenRouter, and Flash all failed, so the slower latency is
 * acceptable.
 *
 * Returns null when callSonnet itself errors OR when the resolved tier is
 * Flash (we already tried Flash in tier 4 — no point looping back).
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
      // 300s — Sonnet CLI bootstrap can take 60-90s and synthesis over the
      // 30-row composer payload runs another 30-60s. The previous default
      // (60s) killed the call before the model even started generating,
      // forcing fall-through to paid OpenRouter even when the user has a
      // free Claude Max sub. 300s lets the CLI actually finish when it's
      // someone's free tier.
      timeoutMs: 300_000,
    });
    if (result.tier === 'flash') {
      // callSonnet degraded back to Flash; we already tried Flash in tier 4.
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
  // O8_EVAL_MODE=1 routes Class B through OpenRouter (non-streaming) instead
  // of Sonnet CLI. ~14-16s saved per multi-fact case during eval iteration.
  // Eval doesn't care about TTFT — only final answer correctness. Production
  // path (Sonnet CLI streaming) is unchanged.
  const evalMode = process.env.O8_EVAL_MODE === '1' || process.env.O8_EVAL_MODE === 'true';

  if (evalMode) {
    return composeClassBViaOpenRouter(question, repoPath, topRows, emit, lookup);
  }

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
      // 300s — production Class B is the Sonnet CLI path users on Claude Max
      // get for free. Bootstrap + multi-row synthesis can hit 90-180s; the
      // prior 60s default killed the call before generation finished and
      // forced fall-through to paid OpenRouter. With 300s the free CLI tier
      // actually delivers.
      timeoutMs: 300_000,
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

/**
 * Eval-mode Class B path. Routes the same Sonnet system+user prompt through
 * OpenRouter (non-streaming) instead of Sonnet CLI. ~14-16s saved per case.
 * Used only when O8_EVAL_MODE=1.
 */
async function composeClassBViaOpenRouter(
  question: string,
  repoPath: string | undefined,
  topRows: TypedRow[],
  emit: SseEmit,
  lookup: Map<string, TypedRow>,
): Promise<void> {
  try {
    const system = buildSonnetComposeSystem();
    const user = buildSonnetComposeUser(question, repoPath, topRows);
    // Eval-mode primary = Sonnet 4.6 (matches Class A) — best synthesis for
    // the ship-gate signal. ~$0.026/smoke-run. grok stays as the fallback
    // path inside callOpenRouter's models[] chain.
    const fullText = await callOpenRouter(`${system}\n\n${user}`, {
      timeoutMs: 30_000,
      model: 'anthropic/claude-sonnet-4-6',
    });

    let finalAnswer = '';
    if (fullText.trim()) {
      emit('token', { text: fullText });
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
      emit('token', { text: 'I don\'t have that information yet — try indexing more directives or PRs.' });
    }

    if (finalAnswer.trim()) {
      try {
        const contradictions = await detectContradictions({ rows: topRows, answer: finalAnswer });
        for (const c of contradictions) {
          emit('contradiction', c);
        }
      } catch {
        // Contradiction pass is best-effort.
      }
    }

    emit('done', {});
  } catch (err) {
    const message = err instanceof Error ? err.message : 'composer-B-eval error';
    console.warn('[qa][composer-B-eval] error:', message);
    return composeClassA(question, repoPath, topRows, emit);
  }
}
