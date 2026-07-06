import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

export function resolveWorkerEffortDefault(options: {
  runtime: OrchestratorRuntime;
  explicitEffort?: ThinkingEffort | null;
  codexWorkerEffort: ThinkingEffort;
  claudeWorkerEffort: ThinkingEffort;
}): ThinkingEffort | undefined {
  if (options.explicitEffort) return options.explicitEffort;
  const fallback = options.runtime === 'codex'
    ? options.codexWorkerEffort
    : options.runtime === 'claude-code'
      ? options.claudeWorkerEffort
      : 'adaptive';
  return fallback === 'adaptive' ? undefined : fallback;
}
