import type {
  MobileTranscriptEntry,
  MobileTranscriptSource,
  MobileTranscriptToolCall,
} from '@/lib/mobile/types';

export interface ExportThreadMessage {
  id?: string;
  role?: MobileTranscriptEntry['role'];
  text?: string;
  content?: string;
  type?: MobileTranscriptEntry['type'];
  timestamp?: number;
  timestampLabel?: string;
  model?: string;
  tokens?: { input: number; output: number };
  costUsd?: number;
  toolCalls?: MobileTranscriptToolCall[];
  sources?: MobileTranscriptSource[];
  thinking?: string;
  compaction?: MobileTranscriptEntry['compaction'];
}

export interface ExportThreadOptions {
  title?: string | null;
  threadId?: string | null;
}

interface NormalizedExportMessage {
  id: string;
  role: MobileTranscriptEntry['role'];
  text: string;
  type: MobileTranscriptEntry['type'];
  timestamp?: number;
  timestampLabel?: string;
  model?: string;
  tokens?: { input: number; output: number };
  costUsd?: number;
  toolCalls: MobileTranscriptToolCall[];
  sources: MobileTranscriptSource[];
  thinking?: string;
  compaction?: MobileTranscriptEntry['compaction'];
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function firstNonEmptyLine(value: string): string {
  return value
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? '';
}

function summarizeTitle(value: string): string {
  const compact = compactWhitespace(firstNonEmptyLine(value));
  if (!compact) return 'Untitled thread';
  return compact.length > 80 ? `${compact.slice(0, 77).trimEnd()}...` : compact;
}

function normalizeMessage(message: ExportThreadMessage, index: number): NormalizedExportMessage {
  const text = typeof message.text === 'string'
    ? message.text
    : typeof message.content === 'string'
      ? message.content
      : '';

  return {
    id: message.id?.trim() || `thread-message-${index + 1}`,
    role: message.role ?? 'assistant',
    text,
    type: message.type ?? (message.compaction ? 'compaction' : 'message'),
    timestamp: message.timestamp,
    timestampLabel: message.timestampLabel,
    model: message.model,
    tokens: message.tokens,
    costUsd: message.costUsd,
    toolCalls: Array.isArray(message.toolCalls) ? message.toolCalls : [],
    sources: Array.isArray(message.sources) ? message.sources : [],
    thinking: typeof message.thinking === 'string' ? message.thinking : undefined,
    compaction: message.compaction,
  };
}

function resolveThreadTitle(messages: NormalizedExportMessage[], explicitTitle?: string | null): string {
  const title = explicitTitle?.trim();
  if (title) return title;

  const firstUserMessage = messages.find((message) => message.role === 'user' && compactWhitespace(message.text));
  if (firstUserMessage) return summarizeTitle(firstUserMessage.text);

  const firstMessage = messages.find((message) => compactWhitespace(message.text));
  return firstMessage ? summarizeTitle(firstMessage.text) : 'Untitled thread';
}

function roleHeading(role: MobileTranscriptEntry['role']): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function formatTimestamp(timestamp?: number, timestampLabel?: string): string | null {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(timestamp));
  }

  const label = timestampLabel?.trim();
  return label || null;
}

function formatMetadata(message: NormalizedExportMessage): string | null {
  const parts: string[] = [];
  const timestamp = formatTimestamp(message.timestamp, message.timestampLabel);

  if (timestamp) parts.push(timestamp);
  if (message.model?.trim()) parts.push(message.model.trim());
  if (message.tokens) parts.push(`${message.tokens.input} in / ${message.tokens.output} out tokens`);
  if (typeof message.costUsd === 'number' && Number.isFinite(message.costUsd)) {
    parts.push(`$${message.costUsd.toFixed(4)}`);
  }
  if (message.type === 'compaction' && message.compaction?.trigger) {
    parts.push(`compaction: ${message.compaction.trigger}`);
  }

  return parts.length > 0 ? `_${parts.join(' • ')}_` : null;
}

function sanitizeFenceLanguage(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'text';
  return trimmed.replace(/[^\w+-]+/g, '-');
}

function formatToolCallBlock(toolCall: MobileTranscriptToolCall): string {
  const parts: string[] = [];

  if (toolCall.status) {
    parts.push(`status: ${toolCall.status}`);
  }

  if (toolCall.args && Object.keys(toolCall.args).length > 0) {
    parts.push(JSON.stringify(toolCall.args, null, 2));
  }

  if (toolCall.preview?.trim()) {
    parts.push(toolCall.preview.trim());
  }

  const body = parts.join('\n\n') || toolCall.name;
  return `\`\`\`${sanitizeFenceLanguage(toolCall.name)}\n${body}\n\`\`\``;
}

function isAgentDispatch(message: NormalizedExportMessage): boolean {
  const lower = message.text.toLowerCase();
  return message.id.startsWith('agent-update-')
    || lower.includes('sub-agent')
    || lower.includes('agent "')
    || lower.includes('runtime context (internal)')
    || lower.includes('begin_untrusted_child_result');
}

function formatBlockquote(value: string): string[] {
  return value
    .trim()
    .split('\n')
    .map((line) => `> ${line.trim()}`);
}

function formatSources(sources: MobileTranscriptSource[]): string[] {
  if (sources.length === 0) return [];

  const lines = ['### Sources'];
  for (const source of sources) {
    const title = source.title?.trim() || source.path?.trim() || source.url?.trim() || 'Source';
    if (source.url?.trim()) {
      lines.push(`- [${title}](${source.url.trim()})`);
      continue;
    }
    if (source.path?.trim()) {
      lines.push(`- \`${source.path.trim()}\`${title !== source.path.trim() ? ` — ${title}` : ''}`);
      continue;
    }
    lines.push(`- ${title}`);
  }
  return lines;
}

function formatCompactionSummary(message: NormalizedExportMessage): string | null {
  if (message.type !== 'compaction') return null;
  if (!message.compaction) return message.text.trim() || 'Context compaction event';

  const parts = ['Context compaction'];
  if (message.compaction.trigger) parts.push(`trigger: ${message.compaction.trigger}`);
  if (typeof message.compaction.tokensBefore === 'number' && typeof message.compaction.tokensAfter === 'number') {
    parts.push(`${message.compaction.tokensBefore} -> ${message.compaction.tokensAfter} tokens`);
  }
  if (message.compaction.source) parts.push(`source: ${message.compaction.source}`);
  return parts.join(' • ');
}

export function serializeThreadToMarkdown(
  messages: ExportThreadMessage[],
  options: ExportThreadOptions = {},
): string {
  const normalized = messages.map(normalizeMessage);
  const lines: string[] = [];
  const title = resolveThreadTitle(normalized, options.title);

  lines.push(`# Thread: ${title}`);
  if (options.threadId?.trim()) {
    lines.push('');
    lines.push(`_Thread ID: ${options.threadId.trim()}_`);
  }

  for (const message of normalized) {
    lines.push('');
    lines.push(`## ${roleHeading(message.role)}`);

    const metadata = formatMetadata(message);
    if (metadata) {
      lines.push('');
      lines.push(metadata);
    }

    const compactionSummary = formatCompactionSummary(message);
    if (compactionSummary) {
      lines.push('');
      lines.push(...formatBlockquote(compactionSummary));
    } else if (compactWhitespace(message.text)) {
      lines.push('');
      if (isAgentDispatch(message)) {
        lines.push(...formatBlockquote(message.text));
      } else {
        lines.push(message.text.trim());
      }
    }

    if (message.thinking?.trim()) {
      lines.push('');
      lines.push('### Thinking');
      lines.push('');
      lines.push(message.thinking.trim());
    }

    if (message.toolCalls.length > 0) {
      lines.push('');
      lines.push('### Tool Calls');
      for (const toolCall of message.toolCalls) {
        lines.push('');
        lines.push(formatToolCallBlock(toolCall));
      }
    }

    const sourceLines = formatSources(message.sources);
    if (sourceLines.length > 0) {
      lines.push('');
      lines.push(...sourceLines);
    }
  }

  return `${lines.join('\n').trim()}\n`;
}
