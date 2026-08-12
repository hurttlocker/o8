import { parseSessionCost } from './cost-parser';
import { parseCost } from './shared/cost-parser-registry';
import type { RuntimeTelemetry } from './types';

export async function readClaudeRuntimeTelemetry(jsonlPath: string): Promise<RuntimeTelemetry | undefined> {
  const sessionCost = await parseCost('claude-code', [jsonlPath]);
  if (!sessionCost) return undefined;

  // Cost includes native child-agent transcripts. Context pressure remains
  // parent-only because child internals never entered the parent prompt.
  const parentContextCost = await parseSessionCost(jsonlPath, {
    includeChildSessions: false,
  });
  return {
    totalTokens: sessionCost.inputTokens
      + sessionCost.outputTokens
      + sessionCost.cacheReadTokens
      + sessionCost.cacheWriteTokens,
    contextTokens: parentContextCost.inputTokens
      + parentContextCost.outputTokens
      + parentContextCost.cacheReadTokens
      + parentContextCost.cacheWriteTokens,
    estimatedCostUsd: sessionCost.totalCostUsd,
    inputTokens: sessionCost.inputTokens,
    outputTokens: sessionCost.outputTokens,
    cacheReadTokens: sessionCost.cacheReadTokens,
    cacheWriteTokens: sessionCost.cacheWriteTokens,
    model: sessionCost.model ?? undefined,
  };
}
