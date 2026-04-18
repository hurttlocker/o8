import type { ParsedOrchestratorSlashCommand, SlashCommandContext, SlashCommandExecutionResult } from './types';

export async function handleClearSlashCommand(
  _command: ParsedOrchestratorSlashCommand,
  context: SlashCommandContext,
): Promise<SlashCommandExecutionResult> {
  await context.clearThread();
  return { handled: true };
}
