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
1. Answer in 1-3 sentences. Be direct and specific.
2. Cite EVERY fact using the row's citation handle in [BRACKET-ID] form (e.g. [D-014] for directives, [O-481] for outcomes, [PR-650] for PRs).
3. Do not invent facts not present in the rows.
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

// ── Class A composer (Flash, non-streaming) ───────────────────────────────────

export async function composeClassA(
  question: string,
  repoPath: string | undefined,
  topRows: TypedRow[],
  emit: SseEmit,
): Promise<void> {
  const apiKey =
    process.env.GOOGLE_AI_API_KEY ??
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    process.env.GEMINI_API_KEY;

  const lookup = buildCitationLookup(topRows);
  const rowsJson = JSON.stringify(
    topRows.slice(0, 15).map((r) => ({
      handle: buildCitationHandle(r),
      excerpt: r.citation.excerpt ?? '',
    })),
  );

  if (!apiKey) {
    // Degrade to a "no key" message so the UI still shows something.
    emit('token', { text: 'No Google AI key configured. Answer unavailable.' });
    emit('done', {});
    return;
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: buildFlashComposePrompt(question, rowsJson) }],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 300,
          },
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      emit('token', { text: `Answer unavailable (API error ${res.status}).` });
      console.warn(`[qa][composer-A] Flash error ${res.status}: ${errText.slice(0, 200)}`);
      emit('done', {});
      return;
    }

    const json = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const rawAnswer = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!rawAnswer.trim()) {
      emit('token', { text: 'I don\'t have that information yet.' });
      emit('done', {});
      return;
    }

    const { translatedAnswer, verifiedRows } = translateCitations(rawAnswer, lookup);

    // Emit token then verified citations.
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
  } catch (err) {
    const message = err instanceof Error ? err.message : 'composer-A error';
    console.warn('[qa][composer-A] error:', message);
    emit('token', { text: 'I don\'t have that information yet.' });
    emit('done', {});
  }
}

// ── Class B composer (Sonnet, streaming) ─────────────────────────────────────

export async function composeClassB(
  question: string,
  repoPath: string | undefined,
  topRows: TypedRow[],
  emit: SseEmit,
): Promise<void> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!anthropicKey) {
    // Fall back to Flash if no Anthropic key.
    console.info('[qa][composer-B] No ANTHROPIC_API_KEY — falling back to Flash compose');
    return composeClassA(question, repoPath, topRows, emit);
  }

  const lookup = buildCitationLookup(topRows);

  try {
    const body = {
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: buildSonnetComposeSystem(),
      messages: [
        {
          role: 'user',
          content: buildSonnetComposeUser(question, repoPath, topRows),
        },
      ],
      stream: true,
    };

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      console.warn(`[qa][composer-B] Anthropic error ${res.status}: ${errText.slice(0, 200)}`);
      // Degrade to Flash.
      return composeClassA(question, repoPath, topRows, emit);
    }

    // Stream SSE from Anthropic. We collect the full text so we can post-process
    // citations, while also emitting tokens as they arrive for TTFT.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    // Token buffer — emit tokens as they arrive, accumulate for post-processing.
    const flushToken = (text: string) => {
      if (!text) return;
      fullText += text;
      emit('token', { text });
    };

    let lineBuffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        lineBuffer += line + '\n';
        if (line === '') {
          // End of an SSE block.
          const block = lineBuffer;
          lineBuffer = '';
          if (!block.includes('data: ')) continue;
          const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          const raw = dataLine.slice(6).trim();
          if (raw === '[DONE]') break;
          try {
            const evt = JSON.parse(raw) as {
              type?: string;
              delta?: { type?: string; text?: string };
            };
            if (
              evt.type === 'content_block_delta' &&
              evt.delta?.type === 'text_delta' &&
              evt.delta.text
            ) {
              flushToken(evt.delta.text);
            }
          } catch {
            // Ignore parse failures in mid-stream.
          }
        }
      }
    }

    // Post-process: translate bracket citations → verified CITATION markers.
    if (fullText.trim()) {
      const { verifiedRows } = translateCitations(fullText, lookup);
      // Emit verified citations after streaming completes.
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
    emit('done', {});
  } catch (err) {
    const message = err instanceof Error ? err.message : 'composer-B error';
    console.warn('[qa][composer-B] error:', message);
    // Degrade to Flash.
    return composeClassA(question, repoPath, topRows, emit);
  }
}
