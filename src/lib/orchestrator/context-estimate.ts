import type { MobileTranscriptEntry } from '@/lib/mobile/types';

export const ORCHESTRATOR_SYSTEM_PROMPT_ESTIMATE_TOKENS = 4_000;

/** Text-only fallback, independent of billing counters. Include the system
 * prompt allowance, retained summaries, tool arguments and tool results. */
export function estimateOrchestratorContext(messages: readonly MobileTranscriptEntry[]): number {
  let tokens = ORCHESTRATOR_SYSTEM_PROMPT_ESTIMATE_TOKENS;
  for (const entry of messages) {
    const text = entry.type === 'compaction' ? entry.compaction?.summary ?? entry.text : entry.text;
    tokens += 8 + Math.ceil(((text?.length ?? 0) + (entry.thinking?.length ?? 0)) / 4);
    for (const tool of entry.toolCalls ?? []) {
      tokens += 8 + Math.ceil((tool.name.length + JSON.stringify(tool.args ?? {}).length
        + (tool.result?.length ?? tool.preview?.length ?? 0)) / 4);
    }
  }
  return tokens;
}
