import { buildSlashCommandEntry } from './shared';
import type { ParsedOrchestratorSlashCommand, SlashCommandContext, SlashCommandExecutionResult } from './types';

export async function handleClearSlashCommand(
  _command: ParsedOrchestratorSlashCommand,
  context: SlashCommandContext,
): Promise<SlashCommandExecutionResult> {
  await context.clearThread();
  context.appendEntries([
    buildSlashCommandEntry({
      name: 'clear',
      summary: 'Started a fresh orchestrator thread.',
      details: ['Archived the previous thread to history and reset the remote session.'],
      chips: [{ label: 'fresh thread', tone: 'emerald' }],
    }),
  ]);
  return { handled: true };
}
