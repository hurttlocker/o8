import {
  parseSidebarRuntimeEventSummary,
} from '@/lib/chat/sidebar-events';
import type {
  MobileTranscriptEntry,
  MobileTranscriptRuntimeEvent,
  MobileTranscriptToolCall,
} from '@/lib/mobile/types';

const CONTROL_TAGS = new Set([
  'command-name',
  'command-message',
  'command-args',
  'local-command-caveat',
  'local-command-stdout',
  'task-notification',
  'task-id',
  'tool-use-id',
  'output-file',
  'status',
  'summary',
]);

const CONTROL_TAG_HINT = /(command|task|result|runtime|notification|compaction|send|abort|merge|schedule)/i;
const SENSITIVE_KEY_PATTERN = /(^|[_-])(authorization|api[_-]?key|token|secret|password|passwd|cookie|session(id)?)([_-]|$)/i;
const HIDE_RUNTIME_TEXT_PATTERN = /<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>|runtime context \(internal\)|ready for user delivery|task completion event/i;

function normalizeText(value: string) {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeInline(value: string) {
  return normalizeText(value).replace(/\s+/g, ' ').trim();
}

function truncate(value: string, max = 180) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function humanizeTag(tag: string) {
  return tag
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (part) => part.toUpperCase());
}

function basenameish(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized;
}

function isPlaceholderValue(value: string) {
  const trimmed = value.trim();
  return /^\$[{(]?[A-Z0-9_]+/i.test(trimmed);
}

export function redactSensitiveText(text: string) {
  let cleaned = text;

  cleaned = cleaned.replace(
    /(Authorization\s*:\s*Bearer\s+)([^\s"'`<]+)/gi,
    '$1[REDACTED]',
  );
  cleaned = cleaned.replace(
    /\b(Bearer\s+)([A-Za-z0-9._~+/-]{12,})/g,
    '$1[REDACTED]',
  );
  cleaned = cleaned.replace(
    /(["']?(?:token|secret|password|authorization|api[_-]?key)["']?\s*[:=]\s*["'])([^"']+)(["'])/gi,
    '$1[REDACTED]$3',
  );
  cleaned = cleaned.replace(
    /\b((?:token|secret|password|api[_-]?key)\s*[:=]\s*)([^\s,;'"`]+)/gi,
    '$1[REDACTED]',
  );
  cleaned = cleaned.replace(
    /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY))\s*=\s*(["']?)([^"'\s$][^"'\s]*)(\2)/g,
    '$1=[REDACTED]',
  );
  cleaned = cleaned.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+(?:\.[A-Za-z0-9._-]+)?\b/g, '[REDACTED]');
  cleaned = cleaned.replace(/\b(?:sk|rk|sess)-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]');
  cleaned = cleaned.replace(/\bgh[pousr]_[A-Za-z0-9_]{10,}\b/g, '[REDACTED]');

  return cleaned;
}

function sanitizeUnknown(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key && SENSITIVE_KEY_PATTERN.test(key) && !isPlaceholderValue(value)) {
      return '[REDACTED]';
    }
    return redactSensitiveText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item, key));
  }

  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(entryKey)) {
        sanitized[entryKey] = typeof entryValue === 'string' && isPlaceholderValue(entryValue)
          ? entryValue
          : '[REDACTED]';
        continue;
      }
      sanitized[entryKey] = sanitizeUnknown(entryValue, entryKey);
    }
    return sanitized;
  }

  return value;
}

export function sanitizeDesktopToolCalls(toolCalls: MobileTranscriptToolCall[] | undefined) {
  if (!toolCalls?.length) return undefined;

  return toolCalls.map((tool) => ({
    ...tool,
    args: tool.args ? sanitizeUnknown(tool.args) as Record<string, unknown> : undefined,
    preview: tool.preview ? redactSensitiveText(tool.preview) : undefined,
  }));
}

function extractTagValue(text: string, tag: string) {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!match?.[1]) return undefined;
  const value = normalizeInline(redactSensitiveText(match[1]));
  return value || undefined;
}

function isControlTag(tag: string) {
  return CONTROL_TAGS.has(tag) || CONTROL_TAG_HINT.test(tag);
}

function stripControlMarkup(text: string) {
  let cleaned = text.replace(
    /<([a-z][a-z0-9-]*)>[\s\S]*?<\/\1>/gi,
    (segment, tag: string) => (isControlTag(tag.toLowerCase()) ? ' ' : segment),
  );

  cleaned = cleaned.replace(/Read the output file to retrieve the result:\s*\S+/gi, ' ');
  cleaned = cleaned.replace(/<\/?(?:[a-z][a-z0-9-]*)>/gi, (segment) => {
    const tag = segment.replace(/[</>\s]/g, '').replace(/^\/+/, '').toLowerCase();
    return isControlTag(tag) ? ' ' : segment;
  });

  return normalizeText(cleaned);
}

function buildTaskRuntimeEvent(text: string): MobileTranscriptRuntimeEvent | null {
  if (!/<task-notification>/i.test(text)) return null;

  const taskId = extractTagValue(text, 'task-id');
  const status = extractTagValue(text, 'status');
  const summary = extractTagValue(text, 'summary');
  const outputFile = extractTagValue(text, 'output-file');

  return {
    kind: 'task',
    title: taskId ? `Background task ${taskId}` : 'Background task',
    summary: summary ?? 'Claude Code posted a background task update.',
    status,
    task: taskId,
    outputLabel: basenameish(outputFile),
    rawPreviewLines: outputFile ? [`Output: ${basenameish(outputFile)}`] : undefined,
  };
}

function buildCommandRuntimeEvent(text: string): MobileTranscriptRuntimeEvent | null {
  if (!/(<command-name>|<command-message>|<command-args>|<local-command-caveat>|<local-command-stdout>)/i.test(text)) {
    return null;
  }

  const commandName = extractTagValue(text, 'command-name') ?? extractTagValue(text, 'command-message');
  const commandMessage = extractTagValue(text, 'command-message');
  const commandArgs = extractTagValue(text, 'command-args');
  const caveat = extractTagValue(text, 'local-command-caveat');
  const stdout = extractTagValue(text, 'local-command-stdout');
  const label = commandName
    ? (commandName.startsWith('/') ? commandName : `/${commandName}`)
    : 'runtime command';

  const rawPreviewLines = [
    commandMessage && commandMessage !== commandName ? commandMessage : undefined,
    commandArgs ? `Args: ${commandArgs}` : undefined,
    caveat,
    stdout ? truncate(stdout) : undefined,
  ].filter(Boolean) as string[];

  return {
    kind: 'command',
    title: `Command ${label}`,
    summary: `Claude Code ran ${label}.`,
    commandName,
    commandMessage,
    commandArgs,
    rawPreviewLines: rawPreviewLines.length > 0 ? rawPreviewLines : undefined,
  };
}

function buildGenericControlRuntimeEvent(text: string): MobileTranscriptRuntimeEvent | null {
  const tags = Array.from(text.matchAll(/<([a-z][a-z0-9-]*)>/gi))
    .map((match) => match[1].toLowerCase())
    .filter((tag, index, values) => values.indexOf(tag) === index);

  if (tags.length === 0 || !isControlTag(tags[0])) {
    return null;
  }

  const primaryTag = tags[0];
  const status = extractTagValue(text, 'status');
  const summary = extractTagValue(text, 'summary')
    ?? extractTagValue(text, 'message')
    ?? extractTagValue(text, 'note')
    ?? extractTagValue(text, 'result')
    ?? `${humanizeTag(primaryTag)} captured by Claude Code.`;

  const rawPreviewLines = [
    extractTagValue(text, 'message'),
    extractTagValue(text, 'note'),
    extractTagValue(text, 'result'),
  ]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .filter((value) => value !== summary)
    .map((value) => truncate(value as string))
    .slice(0, 3) as string[];

  return {
    kind: 'runtime',
    title: humanizeTag(primaryTag),
    summary,
    status,
    rawPreviewLines: rawPreviewLines.length > 0 ? rawPreviewLines : undefined,
  };
}

function buildRuntimeEvent(text: string): MobileTranscriptRuntimeEvent | undefined {
  const taskEvent = buildTaskRuntimeEvent(text);
  if (taskEvent) return taskEvent;

  const commandEvent = buildCommandRuntimeEvent(text);
  if (commandEvent) return commandEvent;

  const handoff = parseSidebarRuntimeEventSummary(text);
  if (handoff) {
    return {
      kind: 'handoff',
      ...handoff,
    };
  }

  return buildGenericControlRuntimeEvent(text) ?? undefined;
}

export function sanitizeDesktopTranscriptEntry(entry: MobileTranscriptEntry): MobileTranscriptEntry {
  const redactedText = redactSensitiveText(entry.text);
  const runtimeEvent = entry.runtimeEvent ?? buildRuntimeEvent(redactedText);
  const strippedText = runtimeEvent ? stripControlMarkup(redactedText) : normalizeText(redactedText);
  const nextText = runtimeEvent && HIDE_RUNTIME_TEXT_PATTERN.test(redactedText)
    ? ''
    : strippedText;
  const nextRole = runtimeEvent && entry.role !== 'assistant' ? 'system' : entry.role;

  return {
    ...entry,
    role: nextRole,
    text: nextText,
    toolCalls: sanitizeDesktopToolCalls(entry.toolCalls),
    runtimeEvent,
  };
}

export function sanitizeDesktopTranscriptEntries(entries: MobileTranscriptEntry[]) {
  return entries.map((entry) => sanitizeDesktopTranscriptEntry(entry));
}
