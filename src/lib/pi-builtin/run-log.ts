import { compactText, formatClock } from '@/lib/runtimes/shared/owned-session/helpers';
import type { OwnedTailEntry } from '@/lib/runtimes/shared/owned-session/types';
import { truncateText } from '@/lib/util/text';
import type { PiWorkerLogLine, PiWorkerRunRecord } from './types';

const MAX_TOOL_OUTPUT = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textParts(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map(part => (isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/**
 * Maps one Pi agent event to run-log lines. A finished assistant message keeps
 * its text only; tool calls keep name, arguments and result text.
 */
export function piWorkerLogLines(event: Record<string, unknown>): PiWorkerLogLine[] {
  const id = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
  if (event.type === 'message_end' && isRecord(event.message) && event.message.role === 'assistant') {
    const text = textParts(event.message.content).trim();
    return text ? [{ type: 'assistant', text }] : [];
  }
  if (event.type === 'tool_execution_start' && typeof event.toolName === 'string') {
    return [{ type: 'tool_call', id, name: event.toolName, args: isRecord(event.args) ? event.args : {} }];
  }
  if (event.type === 'tool_execution_end' && typeof event.toolName === 'string') {
    const result = isRecord(event.result) ? textParts(event.result.content) : '';
    return [{ type: 'tool_result', id, name: event.toolName, output: truncateText(result, MAX_TOOL_OUTPUT),
      isError: event.isError === true }];
  }
  return [];
}

/** Parses a run log into transcript entries. Unknown or torn lines are skipped. */
export function parsePiWorkerRunLog(raw: string, run: PiWorkerRunRecord): OwnedTailEntry[] {
  const entries: OwnedTailEntry[] = [];
  raw.split('\n').forEach((line, index) => {
    let parsed: (PiWorkerLogLine & { at?: string }) | null = null;
    try { parsed = line.trim() ? JSON.parse(line) : null; } catch { parsed = null; }
    if (!parsed) return;
    const timestamp = typeof parsed.at === 'string' ? parsed.at : run.startedAt;
    const base = { id: `${run.id}:${index}`, timestamp, timestampLabel: formatClock(timestamp) };
    if (parsed.type === 'assistant') {
      entries.push({ ...base, kind: 'message', label: 'Pi', text: parsed.text });
    } else if (parsed.type === 'tool_call') {
      entries.push({ ...base, kind: 'tool', label: parsed.name, text: compactText(JSON.stringify(parsed.args), 400),
        toolCall: { id: parsed.id, name: parsed.name, args: parsed.args, status: 'running' } });
    } else if (parsed.type === 'tool_result') {
      // Carries the call id, so the transcript pairs it with its call and marks that call done.
      entries.push({ ...base, kind: 'tool-output', label: parsed.isError ? `${parsed.name} failed` : parsed.name,
        text: parsed.output, toolCall: { id: parsed.id, name: parsed.name, status: 'done',
          preview: compactText(`${parsed.isError ? 'Failed: ' : ''}${parsed.output}`, 400) } });
    } else if (parsed.type === 'settled' && parsed.outcome !== 'finished') {
      entries.push({ ...base, kind: 'event', label: 'Pi', text: parsed.summary });
    }
  });
  return entries;
}
