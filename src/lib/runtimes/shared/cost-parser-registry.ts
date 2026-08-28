/**
 * Cost-Parser Registry
 *
 * Central registry for per-runtime cost parsers.  Adapters register themselves
 * at import time; callers resolve via `parseCost(runtimeId, paths)`.
 *
 * New runtimes (Gemini, opencode, …) call `registerCostParser` in their own
 * module — no changes needed here.
 */

// ── Public types ─────────────────────────────────────────────────────────────

export interface SessionCostData {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUsd: number;
  model: string | null;
  costSource?: 'gateway' | 'estimate' | 'unknown';
}

export interface CostParser {
  runtimeId: string;
  parseFiles(paths: string[], opts?: { fallbackModel?: string | null }): Promise<SessionCostData>;
  parseLines?(lines: string[], opts?: { fallbackModel?: string | null }): Promise<SessionCostData>;
}

// ── Registry state ────────────────────────────────────────────────────────────

const registry = new Map<string, CostParser>();

// ── Public API ────────────────────────────────────────────────────────────────

export function registerCostParser(parser: CostParser): void {
  registry.set(parser.runtimeId, parser);
}

export function getCostParser(runtimeId: string): CostParser | undefined {
  return registry.get(runtimeId);
}

/**
 * Parse session cost for a given runtime.
 *
 * Returns `null` when no parser is registered for the runtime — callers decide
 * whether to warn or silently ignore.
 */
export async function parseCost(
  runtimeId: string,
  paths: string[],
  opts?: { fallbackModel?: string | null },
): Promise<SessionCostData | null> {
  const parser = registry.get(runtimeId);
  if (!parser) {
    return null;
  }
  return parser.parseFiles(paths, opts);
}
