import { buildRecallPrelude, buildSlashCommandEntry } from './shared';
import type { ParsedOrchestratorSlashCommand, SlashCommandContext, SlashCommandExecutionResult } from './types';

export async function handleRecallSlashCommand(
  command: ParsedOrchestratorSlashCommand,
  context: SlashCommandContext,
): Promise<SlashCommandExecutionResult> {
  const keyword = command.args.trim();
  if (!keyword) {
    context.appendEntries([
      buildSlashCommandEntry({
        name: 'recall',
        summary: 'Recall needs a keyword to search the orchestrator archive.',
        details: ['Example: /recall packet queue', 'Example: /recall src/lib/orchestrator/store.ts'],
        chips: [{ label: 'argument required', tone: 'amber' }],
      }),
    ]);
    return { handled: true };
  }

  const matches = await context.searchArchive(keyword, 4);
  if (matches.length === 0) {
    context.appendEntries([
      buildSlashCommandEntry({
        name: 'recall',
        summary: `No archived turns matched "${keyword}".`,
        chips: [{ label: 'no matches', tone: 'slate' }],
      }),
    ]);
    return { handled: true };
  }

  context.queuePrelude(buildRecallPrelude(keyword, matches.slice(0, 3)), 'append');
  context.appendEntries([
    buildSlashCommandEntry({
      name: 'recall',
      summary: `Queued ${matches.length} archived match${matches.length === 1 ? '' : 'es'} for the next turn.`,
      details: matches.slice(0, 3).map((match, index) => `Match ${index + 1}: ${match.preview}`),
      chips: [
        { label: keyword, tone: 'blue' },
        { label: `${matches.length} match${matches.length === 1 ? '' : 'es'}`, tone: 'emerald' },
      ],
    }),
  ]);
  return { handled: true };
}
