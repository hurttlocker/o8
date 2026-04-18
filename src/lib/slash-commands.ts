export interface SlashCommandDefinition {
  command: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  { command: '/help', description: 'Show available commands' },
  { command: '/compact', description: 'Compact conversation history' },
  { command: '/clear', description: 'Clear terminal output' },
  { command: '/cost', description: 'Show token usage' },
  { command: '/status', description: 'Show agent status' },
  { command: '/review', description: 'Review current changes' },
];

export function normalizeSlashInput(value: string) {
  return value.trimStart();
}

export function isSlashCommandText(value: string | null | undefined) {
  const normalized = normalizeSlashInput(value ?? '');
  return normalized.startsWith('/');
}

export function getSlashCommandSuggestions(value: string) {
  const normalized = normalizeSlashInput(value);
  if (!normalized.startsWith('/')) return [];

  return SLASH_COMMANDS.filter((item) => item.command.startsWith(normalized.toLowerCase()));
}

export function autocompleteSlashCommand(value: string) {
  const suggestions = getSlashCommandSuggestions(value);
  return suggestions[0]?.command ?? null;
}

export function buildSlashTerminalInput(value: string) {
  return `${normalizeSlashInput(value).trim()}\r`;
}

export * from './slash-commands/index';
