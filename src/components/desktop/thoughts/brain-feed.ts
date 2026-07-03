/**
 * Brain→Fable transparency card — pure logic (2026-07-02).
 *
 * When the active orchestrator backend is METERED (per-token billing — fable
 * today), every `cortex_ask` the orchestrator makes should be auditable in the
 * workspace chat: what question the Brain was asked, which titled sources it
 * answered from, and roughly how many tokens the digest put into the metered
 * window vs what a raw read of the same sources would have cost (the visible
 * offload). This module owns the parsing + gating + token math; the rendering
 * lives in `chat-panel/BrainFeedCard.tsx`, the wiring in
 * `use-orchestrator-stream/socket.ts` (`tool-result` case).
 *
 * PURE — no React, no fetch. Import-safe from both the stream handler and the
 * card. Backend gating goes through `orchestrator-backends/billing` (the pure
 * leaf), never the registry (bundle trap).
 */

import type { BrainFeed, BrainFeedCitation, MobileTranscriptToolCall } from '@/lib/mobile/types';
import { isOrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { isMeteredOrchestratorBackend } from '@/lib/lane/orchestrator-backends/billing';

/** Matches the chip classifier's rule (`ToolCallChip.classifyToolCall`) —
 *  covers both the bare tool name and the `mcp__o8__`-prefixed form. */
export function isCortexAskTool(name: string): boolean {
  return name.toLowerCase().endsWith('cortex_ask');
}

/** The transparency card renders only for cortex_ask calls whose turn ran on
 *  a metered backend AND whose result parsed into a structured feed. */
export function isMeteredBrainFeedCall(tool: MobileTranscriptToolCall): boolean {
  return Boolean(
    tool.brainFeed
    && typeof tool.backend === 'string'
    && isOrchestratorBackendId(tool.backend)
    && isMeteredOrchestratorBackend(tool.backend),
  );
}

function asOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseCitations(value: unknown): BrainFeedCitation[] {
  if (!Array.isArray(value)) return [];
  const citations: BrainFeedCitation[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.kind !== 'string' || typeof record.rowId !== 'string') continue;
    citations.push({
      kind: record.kind,
      rowId: record.rowId,
      title: typeof record.title === 'string' ? record.title : undefined,
      excerpt: typeof record.excerpt === 'string' ? record.excerpt : undefined,
      url: typeof record.url === 'string' ? record.url : null,
    });
  }
  return citations;
}

/**
 * Parse a cortex_ask tool RESULT (the MCP handler's jsonResult blob — see
 * `operator-handlers/cortex.ts handleAsk`) into a structured BrainFeed.
 * Returns null for anything that isn't a successful ask — an error result,
 * a non-JSON payload, a different tool's output. The card simply doesn't
 * render then; the plain Brain chip still does.
 */
export function parseBrainFeed(
  output: string,
  args?: Record<string, unknown>,
): BrainFeed | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // MCP result content can be wrapped/joined with extra text — retry on the
    // outermost object literal before giving up.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.ok !== true || typeof record.answer !== 'string') return null;

  const question = typeof args?.question === 'string' ? args.question.trim() : '';
  const cacheHit = record.cacheHit === 'exact' || record.cacheHit === 'semantic'
    ? record.cacheHit
    : null;

  return {
    question,
    answer: record.answer,
    citations: parseCitations(record.citations),
    sourcesConsidered: asOptionalNumber(record.sourcesConsidered),
    retrievalMs: asOptionalNumber(record.retrievalMs),
    cacheHit,
    consideredChars: asOptionalNumber(record.consideredChars),
  };
}

export interface BrainOffload {
  /** Approx tokens the Brain's digest actually put into the metered window. */
  windowTokens: number;
  /** Approx tokens a raw read of the considered sources would have cost. */
  absorbedTokens: number;
}

const tokensFromChars = (chars: number) => Math.max(0, Math.ceil(chars / 4));

/**
 * The offload line's numbers — derivable only when the server reported
 * `consideredChars` (fresh pipeline runs; cache hits and older servers
 * return null → the card omits the line gracefully).
 *
 * `rawResultChars` is the length of the full tool-result string (answer +
 * citation JSON) — that whole blob is what entered the metered window, so
 * prefer it over the bare answer length when available.
 */
export function brainOffload(
  feed: BrainFeed,
  rawResultChars?: number,
): BrainOffload | null {
  if (feed.consideredChars === null || feed.consideredChars <= 0) return null;
  const windowChars = typeof rawResultChars === 'number' && rawResultChars > 0
    ? rawResultChars
    : feed.answer.length;
  if (windowChars <= 0) return null;
  return {
    windowTokens: tokensFromChars(windowChars),
    absorbedTokens: tokensFromChars(feed.consideredChars),
  };
}

/** Compact token count for the offload line — 842 → "842", 9412 → "9.4k". */
export function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  const rounded = thousands >= 100 ? Math.round(thousands).toString() : thousands.toFixed(1).replace(/\.0$/, '');
  return `${rounded}k`;
}
