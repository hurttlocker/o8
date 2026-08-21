import path from 'node:path';

import { getOwnedClaudeCodeTelemetrySources } from '@/lib/claude-code/owned';
import { readMeteredGatewayTelemetry } from '@/lib/claude-code/metered-gateway';
import { readClaudeRuntimeTelemetryFromPaths } from '@/lib/runtimes/claude-cost-attribution';
import type { RuntimeTelemetry } from '@/lib/runtimes/types';

export async function readOwnedClaudeRuntimeTelemetry(sessionKey: string): Promise<RuntimeTelemetry | undefined> {
  const sources = await getOwnedClaudeCodeTelemetrySources(sessionKey);
  if (!sources || sources.stdoutPaths.length === 0) return undefined;
  const estimate = await readClaudeRuntimeTelemetryFromPaths(sources.stdoutPaths);
  const gateway = await readMeteredGatewayTelemetry(path.dirname(path.dirname(sources.stdoutPaths[0])));
  if (!gateway) return estimate;
  return {
    ...estimate,
    inputTokens: Math.max(gateway.inputTokens, estimate?.inputTokens ?? 0),
    outputTokens: Math.max(gateway.outputTokens, estimate?.outputTokens ?? 0),
    estimatedCostUsd: gateway.costUsd ?? estimate?.estimatedCostUsd,
    costSource: gateway.costUsd === null ? 'estimate' : 'gateway',
    model: sources.model ?? estimate?.model,
  };
}
