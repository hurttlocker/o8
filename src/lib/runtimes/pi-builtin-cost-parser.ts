import { registerCostParser, type SessionCostData } from '@/lib/runtimes/shared/cost-parser-registry';

/**
 * Bundled Pi bills the managed plan or the free allowance, not a per-session
 * API key, and its run logs carry no usage. The parser reports nothing rather
 * than an estimate; the adapter does not advertise cost telemetry.
 */
export async function parsePiBuiltinSessionCost(
  _paths: string[],
  opts?: { fallbackModel?: string | null },
): Promise<SessionCostData> {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCostUsd: 0,
    model: opts?.fallbackModel ?? null,
    costSource: 'unknown',
  };
}

registerCostParser({
  runtimeId: 'pi-builtin',
  parseFiles: parsePiBuiltinSessionCost,
});
