import { buildSlashCommandEntry } from './shared';
import type { ParsedOrchestratorSlashCommand, SlashCommandContext, SlashCommandExecutionResult } from './types';

/**
 * `/rule <text>` — add a session rule to the active thread. The primary
 * add-path now that the composer's Rules chip only appears once rules exist
 * (Q ruling 2026-07-11): with no chip visible, `/rule` is how you seed the
 * first one. Delegates the POST + refresh to the panel via `addSessionRule`.
 */
export async function handleRuleSlashCommand(
  command: ParsedOrchestratorSlashCommand,
  context: SlashCommandContext,
): Promise<SlashCommandExecutionResult> {
  const text = command.args.trim();
  if (!text) return { handled: false };
  const added = context.addSessionRule ? await context.addSessionRule(text) : false;
  context.appendEntries([
    buildSlashCommandEntry({
      name: 'rule',
      summary: added ? 'Session rule added' : 'Could not add session rule',
      details: added
        ? [text, 'Pinned into every turn and inherited by dispatched agents.']
        : ['No active thread yet — send a message first, then add rules.'],
      chips: [{ label: added ? 'Rules' : 'Skipped', tone: added ? 'emerald' : 'slate' }],
    }),
  ]);
  return { handled: true };
}

/**
 * `/rules` — open the rules manager popover (the full add/remove + inherited
 * directive view). Reachable even when the composer chip is hidden.
 */
export async function handleRulesSlashCommand(
  _command: ParsedOrchestratorSlashCommand,
  context: SlashCommandContext,
): Promise<SlashCommandExecutionResult> {
  context.openRulesManager?.();
  return { handled: true };
}
