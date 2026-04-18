import type { OrchestratorSlashCommandDefinition } from './types';

export const ORCHESTRATOR_SLASH_COMMANDS: OrchestratorSlashCommandDefinition[] = [
  {
    command: '/compact',
    name: 'compact',
    title: 'Compact context',
    description: 'Run the compactor now and keep only the live tail verbatim.',
  },
  {
    command: '/clear',
    name: 'clear',
    title: 'Clear thread',
    description: 'Archive the current thread and reset the orchestrator session.',
  },
  {
    command: '/focus',
    name: 'focus',
    title: 'Focus scope',
    description: 'Keep only turns tied to one issue ref or file path.',
    argHint: '<issue-ref | file-path>',
    requiresArgument: true,
  },
  {
    command: '/status',
    name: 'status',
    title: 'Thread status',
    description: 'Show tokens, cost, active dispatches, and recent decisions.',
  },
  {
    command: '/recall',
    name: 'recall',
    title: 'Recall archive',
    description: 'Pull relevant archived context back into the next turn.',
    argHint: '<keyword>',
    requiresArgument: true,
  },
  {
    command: '/handoff',
    name: 'handoff',
    title: 'Switch model',
    description: 'Compact, reset, and move the orchestrator onto a new model.',
    argHint: '<model-id>',
    requiresArgument: true,
  },
];
