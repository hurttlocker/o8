/**
 * Symbol-graph retriever (epic #915 sub-1).
 *
 * Mines symbol-like tokens out of the question (re-using `extractSymbols`
 * from the codebase-memory client) then traces each through the indexed
 * call graph via `traceSymbols`. Each resolved edge becomes a typed row
 * with a `symbol` citation pointing at the definition file/line.
 *
 * Sub-ms target for the extraction step; the trace_path call is bound by
 * the binary (typically <100ms for a known symbol). Failures degrade —
 * unavailable binary or unknown symbol returns an empty `rows`.
 */

import 'server-only';

import { extractSymbols, traceSymbols } from '@/lib/codebase-memory/client';
import type { RetrieverInput, RetrieverResult, TypedRow } from '@/lib/cortex/qa/types';

const DEFAULT_SYMBOL_LIMIT = 5;

export async function graphRetriever(input: RetrieverInput): Promise<RetrieverResult> {
  const start = Date.now();
  const rows: TypedRow[] = [];

  try {
    if (!input.repoPath) {
      // The binary is per-repo, so without a repoPath we can't trace. Empty
      // result lets the orchestrator fall back to SQL + FTS.
      return { retriever: 'graph', rows, durationMs: Date.now() - start };
    }

    const candidates = extractSymbols(input.question, input.limit ?? DEFAULT_SYMBOL_LIMIT);
    if (candidates.length === 0) {
      return { retriever: 'graph', rows, durationMs: Date.now() - start };
    }

    const traced = await traceSymbols({
      repoPath: input.repoPath,
      symbols: candidates,
    });
    if (traced.unavailable) {
      return { retriever: 'graph', rows, durationMs: Date.now() - start };
    }

    for (const edge of traced.edges) {
      // Skip edges that resolved neither a definition nor any neighbours —
      // those are the "we genuinely don't know this symbol" case and adding
      // them to the citation set would just confuse the composer.
      const hasDefinition = Boolean(edge.file) || edge.line != null;
      const hasNeighbours = edge.neighbours.length > 0;
      if (!hasDefinition && !hasNeighbours) continue;

      rows.push({
        citation: {
          kind: 'symbol',
          rowId: edge.symbol,
          table: 'symbol_graph',
          sourcePath: edge.file ?? undefined,
          line: edge.line ?? undefined,
          excerpt: edge.kind ? `${edge.kind} ${edge.symbol}` : edge.symbol,
        },
        fields: {
          symbol: edge.symbol,
          kind: edge.kind,
          file: edge.file,
          line: edge.line,
          neighbours: edge.neighbours,
          reason: edge.reason ?? null,
        },
        score: 1,
      });
    }
  } catch (error) {
    console.warn(
      '[qa][graph] retriever failed:',
      error instanceof Error ? error.message : error,
    );
  }

  return {
    retriever: 'graph',
    rows,
    durationMs: Date.now() - start,
  };
}
