import { buildSlashCommandEntry } from './shared';
import type { ParsedOrchestratorSlashCommand, SlashCommandContext, SlashCommandExecutionResult } from './types';

/** Explicit intent; keep the selected backend, model, effort, and conversation. */
export async function handleVisualizationSlashCommand(command: ParsedOrchestratorSlashCommand,
  context: SlashCommandContext): Promise<SlashCommandExecutionResult> {
  if (!command.args || !context.startOrchestration || !context.repoPath) {
    context.appendEntries([buildSlashCommandEntry({ name: 'visualization',
      summary: !command.args ? 'What would you like to visualize?' : !context.repoPath ? 'Choose a workspace for this visualization.' : 'Visualizations need an orchestrator conversation.',
      details: ['Example: /visualization show how the request moves through the system'],
    })]);
    return { handled: true };
  }
  await context.startOrchestration({ goal: command.args, rawCommand: command.raw, displayMessage: command.raw,
    prompt: [
      'The user explicitly requested an interactive visualization in this conversation.',
      'Create it directly using o8_html_preview, inspect and refine the screenshot and diagnostics, then publish with o8_html_render before the final reply.',
      'Use the current conversation and supplied attachments as context. Follow the tools\' shared design guidance; verify a narrow layout and both appearances.',
      'Choose a chart, diagram, illustration, or interactive comparison that explains the request. Keep values truthful and label any illustrative data.',
      'This is an inline explanation: do not dispatch workers or modify the workspace merely to draw it. Add only useful interpretation after the visual.',
      '', 'User request:', command.args,
    ].join('\n') });
  return { handled: true };
}
