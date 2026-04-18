import { buildRecallPrelude, buildSlashCommandEntry } from './shared';
import type { ParsedOrchestratorSlashCommand, SlashCommandContext, SlashCommandExecutionResult } from './types';

export async function handleRecallSlashCommand(
  command: ParsedOrchestratorSlashCommand,
  context: SlashCommandContext,
): Promise<SlashCommandExecutionResult> {
  const topic = command.args.trim();
  if (!topic) {
    context.appendEntries([
      buildSlashCommandEntry({
        name: 'recall',
        summary: 'Recall needs a topic to search past orchestrator sessions.',
        details: ['Example: /recall packet queue', 'Example: /recall compaction handoff'],
        chips: [{ label: 'argument required', tone: 'amber' }],
      }),
    ]);
    return { handled: true };
  }

  const matches = await context.searchArchive(topic, 4);
  if (matches.length === 0) {
    context.appendEntries([
      buildSlashCommandEntry({
        name: 'recall',
        summary: `No past sessions matched "${topic}".`,
        chips: [{ label: 'no matches', tone: 'slate' }],
      }),
    ]);
    return { handled: true };
  }

  context.queuePrelude(buildRecallPrelude(topic, matches.slice(0, 3)), 'append');
  context.appendEntries([
    buildSlashCommandEntry({
      name: 'recall',
      summary: `Queued ${matches.length} past-session match${matches.length === 1 ? '' : 'es'} for the next turn.`,
      details: matches.slice(0, 3).map((match, index) => `Match ${index + 1}: ${match.preview}`),
      chips: [
        { label: topic, tone: 'blue' },
        { label: `${matches.length} match${matches.length === 1 ? '' : 'es'}`, tone: 'emerald' },
      ],
    }),
  ]);
  return { handled: true };
}
