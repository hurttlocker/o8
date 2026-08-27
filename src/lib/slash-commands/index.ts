import { handleAskSlashCommand } from './ask';
import { handleClearSlashCommand } from './clear';
import { handleCompactSlashCommand } from './compact';
import { handleFocusSlashCommand } from './focus';
import { handleHandoffSlashCommand } from './handoff';
import { handleOrchestrateSlashCommand } from './orchestrate';
import { handlePromptsSlashCommand } from './prompts';
import { handleRecallSlashCommand } from './recall';
import { handleRuleSlashCommand, handleRulesSlashCommand } from './rules';
import { parseOrchestratorSlashCommand } from './shared';
import { handleStatusSlashCommand } from './status';
import type { ParsedOrchestratorSlashCommand, SlashCommandContext, SlashCommandExecutionResult } from './types';

export type {
  OrchestratorArchiveMatch,
  OrchestratorSlashCommandDefinition,
  OrchestratorSlashCommandName,
  ParsedOrchestratorSlashCommand,
  SlashCommandContext,
  SlashCommandExecutionResult,
  SlashOrchestrationRequest,
  SlashCommandStripChip,
} from './types';

export {
  autocompleteOrchestratorSlashCommand,
  getOrchestratorSlashCommandSuggestions,
  parseOrchestratorSlashCommand,
} from './shared';
export { ORCHESTRATOR_SLASH_COMMANDS } from './definitions';

const HANDLERS: Record<ParsedOrchestratorSlashCommand['command']['name'], (
  command: ParsedOrchestratorSlashCommand,
  context: SlashCommandContext,
) => Promise<SlashCommandExecutionResult>> = {
  ask: handleAskSlashCommand,
  clear: handleClearSlashCommand,
  compact: handleCompactSlashCommand,
  focus: handleFocusSlashCommand,
  handoff: handleHandoffSlashCommand,
  orchestrate: handleOrchestrateSlashCommand,
  prompts: handlePromptsSlashCommand,
  recall: handleRecallSlashCommand,
  rule: handleRuleSlashCommand,
  rules: handleRulesSlashCommand,
  status: handleStatusSlashCommand,
};

export async function executeOrchestratorSlashCommand(
  input: string,
  context: SlashCommandContext,
): Promise<SlashCommandExecutionResult> {
  const command = parseOrchestratorSlashCommand(input);
  if (!command) return { handled: false };
  return HANDLERS[command.command.name](command, context);
}
