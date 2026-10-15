import type { TranscriptEvent } from './transcript-normalizer';

const EPOCH = '1970-01-01T00:00:00.000Z';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clip(value: string, limit: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return EPOCH;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : EPOCH;
}

/**
 * Read only Pi's sanitized owned-run log, never its raw SDK session messages.
 * Sequence numbers describe this bounded snapshot, not durable log offsets:
 * truncation of the read window can renumber them on the next poll.
 */
export function normalizePiBuiltinEvents(rawJsonl: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  // A final record without a newline may still be in the middle of a write.
  for (const line of rawJsonl.split('\n').slice(0, -1)) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!record(value)) continue;
    const base = { seq: events.length + 1, ts: timestamp(value.at) };
    if (value.type === 'assistant' && typeof value.text === 'string' && value.text.trim()) {
      events.push({ ...base, type: 'assistant', text: clip(value.text, 4_000) });
    } else if (value.type === 'tool_call' && typeof value.name === 'string' && value.name.trim()
      && record(value.args)) {
      let args: string;
      try { args = clip(JSON.stringify(value.args), 600); } catch { continue; }
      events.push({ ...base, type: 'tool_call', tool: clip(value.name, 120), args,
        summary: clip(args, 240) });
    } else if (value.type === 'tool_result' && typeof value.name === 'string' && value.name.trim()
      && typeof value.output === 'string' && typeof value.isError === 'boolean') {
      events.push({ ...base, type: 'tool_result', tool: clip(value.name, 120), ok: !value.isError,
        summary: clip(value.output, 240) });
    } else if (value.type === 'settled' && typeof value.summary === 'string') {
      if (value.outcome === 'finished') {
        events.push({ ...base, type: 'done', exitCode: 0 });
      } else if (value.outcome === 'failed' || value.outcome === 'interrupted') {
        events.push({ ...base, type: 'error', message: clip(`Pi ${value.outcome}: ${value.summary}`, 240) });
      }
    }
  }
  return events;
}
