import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type {
  OrchestratorSlashCommandDefinition,
  OrchestratorSlashCommandName,
  ParsedOrchestratorSlashCommand,
  SlashCommandStripChip,
} from './types';
import { ORCHESTRATOR_SLASH_COMMANDS } from './definitions';

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeCommandKey(value: string) {
  return value.trim().toLowerCase();
}

function entryText(entry: MobileTranscriptEntry) {
  const text = entry.type === 'compaction'
    ? entry.compaction?.summary ?? entry.text
    : entry.text;
  const tools = (entry.toolCalls ?? [])
    .map((tool) => {
      const args = tool.args ? JSON.stringify(tool.args) : '';
      const preview = typeof tool.preview === 'string' ? tool.preview : '';
      const result = typeof tool.result === 'string' ? tool.result : '';
      return [tool.name, args, preview, result].filter(Boolean).join(' ');
    })
    .filter(Boolean)
    .join(' ');
  return normalizeWhitespace([text, tools].filter(Boolean).join(' '));
}

export function buildSlashCommandEntry(input: {
  name: OrchestratorSlashCommandName;
  summary: string;
  details?: string[];
  chips?: SlashCommandStripChip[];
}): MobileTranscriptEntry {
  const timestamp = Date.now();
  return {
    id: `slash-${input.name}-${timestamp}`,
    role: 'system',
    type: 'command',
    text: input.summary,
    timestamp,
    timestampLabel: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    command: {
      name: input.name,
      summary: input.summary,
      details: input.details,
      chips: input.chips,
    },
  };
}

export function formatCommandLabel(definition: OrchestratorSlashCommandDefinition) {
  return definition.argHint ? `${definition.command} ${definition.argHint}` : definition.command;
}

export function parseOrchestratorSlashCommand(value: string): ParsedOrchestratorSlashCommand | null {
  const normalized = value.trim();
  if (!normalized.startsWith('/')) return null;

  const [commandToken, ...argParts] = normalized.split(/\s+/);
  const definition = ORCHESTRATOR_SLASH_COMMANDS.find((item) => item.command === normalizeCommandKey(commandToken));
  if (!definition) return null;

  return {
    raw: normalized,
    command: definition,
    args: argParts.join(' ').trim(),
  };
}

export function getOrchestratorSlashCommandSuggestions(value: string) {
  const normalized = value.trimStart();
  if (!normalized.startsWith('/')) return [];

  const commandToken = normalizeCommandKey(normalized.split(/\s+/, 1)[0] ?? '');
  if (!commandToken) return ORCHESTRATOR_SLASH_COMMANDS;

  return ORCHESTRATOR_SLASH_COMMANDS.filter((item) => item.command.startsWith(commandToken));
}

export function autocompleteOrchestratorSlashCommand(value: string) {
  return getOrchestratorSlashCommandSuggestions(value)[0] ?? null;
}

export function excerptTranscriptEntries(entries: MobileTranscriptEntry[], maxEntries = 6, maxChars = 2400) {
  let remaining = maxChars;
  const chunks: string[] = [];
  for (const entry of entries.slice(0, maxEntries)) {
    const role = entry.type === 'compaction' ? 'COMPACTION' : entry.role.toUpperCase();
    const text = entryText(entry);
    if (!text) continue;
    const line = `${role}: ${text}`;
    if (line.length > remaining) {
      chunks.push(`${line.slice(0, Math.max(0, remaining - 1)).trimEnd()}…`);
      break;
    }
    chunks.push(line);
    remaining -= line.length + 1;
    if (remaining <= 0) break;
  }
  return chunks.join('\n');
}

export function collectRecentDecisionLines(entries: MobileTranscriptEntry[], limit = 3) {
  const decisions: string[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.role === 'user') continue;
    if (entry.type === 'command') continue;
    const text = normalizeWhitespace(entry.type === 'compaction'
      ? entry.compaction?.summary ?? entry.text
      : entry.text);
    if (!text) continue;
    const firstLine = text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);
    if (!firstLine) continue;
    decisions.push(firstLine.length > 140 ? `${firstLine.slice(0, 139).trimEnd()}…` : firstLine);
    if (decisions.length >= limit) break;
  }
  return decisions.reverse();
}

export function matchesScope(entry: MobileTranscriptEntry, query: string) {
  const normalizedQuery = normalizeCommandKey(query);
  if (!normalizedQuery) return false;
  const haystack = entryText(entry).toLowerCase();
  if (haystack.includes(normalizedQuery)) return true;
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  return tokens.length > 1 && tokens.every((token) => haystack.includes(token));
}

export function collectFocusedTranscript(entries: MobileTranscriptEntry[], query: string) {
  const keepIndexes = new Set<number>();
  entries.forEach((entry, index) => {
    if (!matchesScope(entry, query)) return;
    keepIndexes.add(index);
    if (index > 0) keepIndexes.add(index - 1);
    if (index < entries.length - 1) keepIndexes.add(index + 1);
  });

  return entries.filter((_, index) => keepIndexes.has(index));
}

export function buildRecallPrelude(query: string, matches: Array<{ source: string; preview: string; entries: MobileTranscriptEntry[] }>) {
  const sections = matches.map((match, index) => {
    const sourceLabel = match.source === 'compaction' ? 'Compaction archive' : 'Saved thread';
    const excerpt = excerptTranscriptEntries(match.entries, 4, 900) || match.preview;
    return [`Source ${index + 1} · ${sourceLabel}`, excerpt].filter(Boolean).join('\n');
  });

  return [
    `Archived recall for "${query}"`,
    ...sections,
    'Use this only when it materially helps the next operator request.',
  ].join('\n\n');
}
