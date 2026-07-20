import 'server-only';

import {
  buildCitationLookup,
  rowDisplayTitle,
  translateCitations,
  type CitationLookup,
} from '@/lib/cortex/qa/citations';
import { composeClassA, limitCitationMarkers, type SseEmit } from '@/lib/cortex/qa/compose-class-a';
import {
  buildSonnetComposeSystem,
  buildSonnetComposeUser,
  type ComposeOptions,
} from '@/lib/prompts/v1';
import { detectContradictions } from '@/lib/cortex/qa/contradictions';
import { callSonnet } from '@/lib/cortex/qa/llm/sonnet-adapter';
import type { TypedRow } from '@/lib/cortex/qa/types';

export async function composeClassB(
  question: string,
  repoPath: string | undefined,
  topRows: TypedRow[],
  emit: SseEmit,
  options: ComposeOptions = {},
): Promise<void> {
  const lookup = buildCitationLookup(topRows);
  // O8_EVAL_MODE=1 routes Class B through OpenRouter (non-streaming) instead
  // of Sonnet CLI. ~14-16s saved per multi-fact case during eval iteration.
  // Eval doesn't care about TTFT — only final answer correctness. Production
  // path (Sonnet CLI streaming) is unchanged.
  const evalMode = process.env.O8_EVAL_MODE === '1' || process.env.O8_EVAL_MODE === 'true';

  if (evalMode) {
    return composeClassBViaSonnetAdapter(question, repoPath, topRows, emit, lookup, options);
  }

  try {
    const result = await callSonnet({
      system: buildSonnetComposeSystem(options),
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
      if (!options.terse) emit('token', { text: token });
    }

    // Post-process: translate bracket citations → verified CITATION markers.
    let finalAnswer = '';
    if (fullText.trim()) {
      const { translatedAnswer: translated, verifiedRows } = translateCitations(fullText, lookup);
      const citationRows = options.terse ? verifiedRows.slice(0, 2) : verifiedRows;
      finalAnswer = options.terse ? limitCitationMarkers(translated, citationRows) : translated;
      if (options.terse) emit('token', { text: finalAnswer });
      for (const row of citationRows) {
        emit('citation', {
          kind: row.citation.kind,
          rowId: `${row.citation.kind}-${row.citation.rowId}`,
          table: row.citation.table,
          title: rowDisplayTitle(row),
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
    return composeClassA(question, repoPath, topRows, emit, options);
  }
}

/**
 * Eval-mode Class B path. Routes the Sonnet system+user prompt through the
 * REPL one-shot adapter (subscription-billed, #1124) instead of either Sonnet
 * CLI streaming or paid OpenRouter `anthropic/claude-sonnet-5`. Same
 * adapter the production Class B path uses (`callSonnet`) — just non-streaming
 * because eval cares about final answer correctness, not TTFT.
 *
 * (Renamed from `composeClassBViaOpenRouter` 2026-06-11 — the implementation
 * stopped touching OpenRouter for the Anthropic models long ago and the old
 * name actively misled the tier-chain audit.)
 */
async function composeClassBViaSonnetAdapter(
  question: string,
  repoPath: string | undefined,
  topRows: TypedRow[],
  emit: SseEmit,
  lookup: CitationLookup,
  options: ComposeOptions = {},
): Promise<void> {
  try {
    const result = await callSonnet({
      system: buildSonnetComposeSystem(options),
      messages: [
        {
          role: 'user',
          content: buildSonnetComposeUser(question, repoPath, topRows),
        },
      ],
      stream: false,
      // Eval mode tolerates the full Sonnet REPL bootstrap; the runner caps
      // overall wall time per case.
      timeoutMs: 300_000,
    });
    if (result.tier === 'flash') {
      // Adapter degraded back to Flash — no Claude path was available, so
      // fall back to Class A (which has its own chain).
      return composeClassA(question, repoPath, topRows, emit, options);
    }
    const fullText = result.text;

    let finalAnswer = '';
    if (fullText.trim()) {
      const { translatedAnswer: translated, verifiedRows } = translateCitations(fullText, lookup);
      const citationRows = options.terse ? verifiedRows.slice(0, 2) : verifiedRows;
      finalAnswer = options.terse ? limitCitationMarkers(translated, citationRows) : translated;
      emit('token', { text: options.terse ? finalAnswer : fullText });
      for (const row of citationRows) {
        emit('citation', {
          kind: row.citation.kind,
          rowId: `${row.citation.kind}-${row.citation.rowId}`,
          table: row.citation.table,
          title: rowDisplayTitle(row),
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
    return composeClassA(question, repoPath, topRows, emit, options);
  }
}
