import { buildSlashCommandEntry } from './shared';
import type { ParsedOrchestratorSlashCommand, SlashCommandContext, SlashCommandExecutionResult } from './types';

export async function handleCompactSlashCommand(
  _command: ParsedOrchestratorSlashCommand,
  context: SlashCommandContext,
): Promise<SlashCommandExecutionResult> {
  const compacted = await context.compactNow({ keepTailCount: 8, source: 'manual' });
  if (!compacted) {
    context.appendEntries([
      buildSlashCommandEntry({
        name: 'compact',
        summary: 'Compaction failed before the orchestrator context could be reduced.',
        chips: [{ label: 'manual', tone: 'amber' }],
      }),
    ]);
    return { handled: true };
  }

  if (!compacted.applied) {
    context.appendEntries([
      buildSlashCommandEntry({
        name: 'compact',
        summary: 'Context is already compact enough. No manual compaction was needed.',
        chips: [{ label: 'no-op', tone: 'slate' }],
      }),
    ]);
    return { handled: true };
  }

  context.replaceTranscript(compacted.transcript);
  return { handled: true };
}
