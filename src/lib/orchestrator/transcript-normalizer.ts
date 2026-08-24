/**
 * Codex Transcript Normalizer
 *
 * Pure transform from raw Codex JSONL (as written by `codex exec` into
 * owned-run stdout files or rollout files) into a compact, agent-friendly
 * event stream.
 *
 * Consolidates `tool_call` / `tool_result` pairs, emits assistant text as a
 * single event, and surfaces terminal events (`done`, `error`). Each event
 * carries a monotonic `seq` so callers can paginate with cursor semantics.
 *
 * The function is a pure string-in → array-out transform and never throws
 * on malformed input. Callers can treat the empty array as a benign signal
 * that the session has no durable transcript yet.
 */

export type TranscriptEvent =
  | { seq: number; ts: string; type: 'tool_call'; tool: string; args: string; summary: string }
  | { seq: number; ts: string; type: 'tool_result'; tool: string; ok: boolean; summary: string }
  | { seq: number; ts: string; type: 'assistant'; text: string }
  | { seq: number; ts: string; type: 'steer'; source: string; text: string; failed?: boolean; note?: string }
  | { seq: number; ts: string; type: 'error'; message: string }
  | { seq: number; ts: string; type: 'done'; exitCode: number };

const MAX_SUMMARY = 240;
const MAX_ASSISTANT_TEXT = 4_000;
const MAX_ARGS = 600;

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStr(source: Record<string, unknown> | null, ...keys: string[]): string {
  if (!source) return '';
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function readNum(source: Record<string, unknown> | null, ...keys: string[]): number | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function clip(input: string | undefined, max: number): string {
  if (!input) return '';
  const collapsed = input.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, Math.max(0, max - 1))}…`;
}

function extractText(source: unknown): string {
  if (typeof source === 'string') return source;
  if (!source || typeof source !== 'object') return '';
  if (Array.isArray(source)) return source.map(extractText).filter(Boolean).join(' ');
  const obj = source as Record<string, unknown>;
  if (typeof obj.text === 'string') return obj.text;
  if (typeof obj.message === 'string') return obj.message;
  if (typeof obj.content === 'string') return obj.content;
  if (Array.isArray(obj.content)) return extractText(obj.content);
  return '';
}

function argsPreview(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return clip(input, MAX_ARGS);
  try { return clip(JSON.stringify(input), MAX_ARGS); } catch { return ''; }
}

function normalizeTs(raw: unknown, fallback: string): string {
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback;
}

interface PendingCall { seq: number; tool: string; }
interface EmittedTool { callIndex: number; resultIndex?: number; tool: string; }

/**
 * Normalize raw Codex JSONL into a TranscriptEvent stream. Never throws —
 * malformed lines are skipped. Returns `[]` when input is empty or entirely
 * unparseable so callers can treat absence as a benign condition.
 */
export function normalizeCodexEvents(
  rawJsonl: string,
  fallbackTimestamp = new Date().toISOString(),
): TranscriptEvent[] {
  if (!rawJsonl || typeof rawJsonl !== 'string') return [];

  const out: TranscriptEvent[] = [];
  const pending = new Map<string, PendingCall>();
  const emitted = new Map<string, EmittedTool>();
  /** tool+args+timestamp → the call id that first emitted it. See pushToolCall. */
  const identityAlias = new Map<string, string>();
  const fallbackTs = fallbackTimestamp;
  let seq = 0;
  const nextSeq = () => (seq += 1);

  const pushToolCall = (ts: string, callId: string, tool: string, args: string) => {
    // Codex carries ONE command in several stream shapes -- `exec_command_begin`,
    // `item.started`, `response_item` -- and each derives its call id
    // differently (`call_id` vs `id` vs `id\0command`). Keyed on id alone, the
    // same command emitted four identical `tool_call` rows sharing a timestamp
    // to the millisecond, and at a 50-event cap those copies displaced real
    // history (#1845). A genuine re-run carries a distinct timestamp, so
    // tool+args+ts identifies the emission itself rather than the shape that
    // announced it.
    const identity = `${tool}\u0000${args}\u0000${ts}`;
    const aliasId = identityAlias.get(identity);
    const previous = emitted.get(callId)
      ?? (aliasId !== undefined ? emitted.get(aliasId) : undefined);
    if (previous) {
      const previousCall = out[previous.callIndex];
      out[previous.callIndex] = {
        seq: previousCall!.seq,
        ts: previousCall!.ts,
        type: 'tool_call',
        tool,
        args,
        summary: clip(args || `call ${tool}`, MAX_SUMMARY),
      };
      previous.tool = tool;
      // Every id shape naming this call must reach the same record, so the
      // result pairs with the row already on screen instead of orphaning.
      emitted.set(callId, previous);
      pending.set(callId, { seq: previousCall!.seq, tool });
      return;
    }
    const thisSeq = nextSeq();
    pending.set(callId, { seq: thisSeq, tool });
    const summary = clip(args || `call ${tool}`, MAX_SUMMARY);
    out.push({ seq: thisSeq, ts, type: 'tool_call', tool, args, summary });
    emitted.set(callId, { callIndex: out.length - 1, tool });
    identityAlias.set(identity, callId);
  };

  const pushToolResult = (ts: string, callId: string | undefined, fallbackTool: string, rawOutput: string, exitCode: number | undefined) => {
    const pendingCall = callId ? pending.get(callId) : undefined;
    if (callId) pending.delete(callId);
    const previous = callId ? emitted.get(callId) : undefined;
    const tool = pendingCall?.tool ?? previous?.tool ?? fallbackTool;
    const output = clip(rawOutput, MAX_SUMMARY);
    const ok = exitCode === undefined ? true : exitCode === 0;
    const previousResult = previous?.resultIndex === undefined ? undefined : out[previous.resultIndex];
    const result: TranscriptEvent = {
      seq: previousResult?.seq ?? nextSeq(), ts: previousResult?.ts ?? ts, type: 'tool_result', tool, ok,
      summary: output || (ok ? 'ok' : `exit ${exitCode}`),
    };
    if (previous && previous.resultIndex !== undefined) {
      out[previous.resultIndex] = result;
      return;
    }
    out.push(result);
    if (previous) previous.resultIndex = out.length - 1;
  };

  for (const rawLine of rawJsonl.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let parsed: Record<string, unknown> | null = null;
    try { parsed = safeObject(JSON.parse(line)); } catch { parsed = null; }
    if (!parsed) continue;

    const type = readStr(parsed, 'type');
    const ts = normalizeTs(parsed.timestamp, fallbackTs);
    const payload = safeObject(parsed.payload);
    const payloadType = payload ? readStr(payload, 'type') : '';

    // Assistant text
    if (type === 'event_msg' && payloadType === 'agent_message') {
      const text = clip(
        typeof payload!.message === 'string' ? payload!.message : extractText(payload!.content),
        MAX_ASSISTANT_TEXT,
      );
      if (text) out.push({ seq: nextSeq(), ts, type: 'assistant', text });
      continue;
    }

    if (type === 'item.completed') {
      const item = safeObject(parsed.item);
      const itemType = item ? readStr(item, 'type') : '';

      if (itemType === 'agent_message') {
        const text = clip(
          readStr(item, 'text') || extractText(item!.content) || extractText(item!.message),
          MAX_ASSISTANT_TEXT,
        );
        if (text) out.push({ seq: nextSeq(), ts, type: 'assistant', text });
        continue;
      }

      if (itemType === 'command_execution') {
        const command = readStr(item, 'command');
        const itemId = readStr(item, 'id');
        const callId = itemId && command ? `${itemId}\u0000${command}` : itemId;
        pushToolResult(ts, callId, 'exec_command', extractText(item!.aggregated_output), readNum(item, 'exit_code'));
        continue;
      }

      if (itemType === 'tool_use') {
        const callId = readStr(item, 'id');
        const fallback = readStr(item, 'name', 'tool_name') || 'tool';
        pushToolResult(ts, callId, fallback, extractText(item!.output ?? item!.result), undefined);
        continue;
      }
    }

    // Tool calls
    if (type === 'response_item' && (payloadType === 'function_call' || payloadType === 'custom_tool_call')) {
      const callId = readStr(payload, 'call_id', 'id') || `tool-${seq + 1}`;
      const tool = readStr(payload, 'name', 'namespace', 'execution') || 'tool';
      const rawArgs = payloadType === 'custom_tool_call' ? payload!.input : payload!.arguments;
      pushToolCall(ts, callId, tool, argsPreview(rawArgs));
      continue;
    }

    if (type === 'event_msg' && payloadType === 'exec_command_begin') {
      const callId = readStr(payload, 'call_id', 'id') || `exec-${seq + 1}`;
      const command = readStr(payload, 'parsed_cmd', 'cmd', 'command');
      pushToolCall(ts, callId, 'exec_command', clip(command, MAX_ARGS));
      continue;
    }

    if (type === 'item.started') {
      const item = safeObject(parsed.item);
      if (item && readStr(item, 'type') === 'command_execution') {
        const command = readStr(item, 'command');
        const itemId = readStr(item, 'id');
        const callId = itemId && command ? `${itemId}\u0000${command}` : itemId || `exec-${seq + 1}`;
        pushToolCall(ts, callId, 'exec_command', clip(command, MAX_ARGS));
        continue;
      }
      if (item && readStr(item, 'type') === 'tool_use') {
        const callId = readStr(item, 'id') || `tool-${seq + 1}`;
        const tool = readStr(item, 'name', 'tool_name') || 'tool';
        const rawInput = item.input ?? item.arguments ?? item.invocation;
        pushToolCall(ts, callId, tool, argsPreview(rawInput));
        continue;
      }
    }

    // Tool results
    if (type === 'response_item' && (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output')) {
      const callId = readStr(payload, 'call_id', 'id');
      pushToolResult(ts, callId, 'tool', extractText(payload!.output), readNum(payload, 'exit_code'));
      continue;
    }

    if (type === 'event_msg' && payloadType === 'exec_command_end') {
      const callId = readStr(payload, 'call_id', 'id');
      const rawOutput = extractText(payload!.aggregated_output ?? payload!.output);
      pushToolResult(ts, callId, 'exec_command', rawOutput, readNum(payload, 'exit_code'));
      continue;
    }

    // Errors
    if (type === 'error' || type === 'turn.failed' || type === 'run.failed'
      || (type === 'event_msg' && payloadType === 'error')) {
      const message = clip(
        readStr(parsed, 'message', 'error')
          || readStr(payload, 'message', 'error')
          || extractText(parsed.error)
          || extractText(payload?.content),
        MAX_SUMMARY,
      );
      out.push({ seq: nextSeq(), ts, type: 'error', message: message || 'Codex run error' });
      continue;
    }

    // Terminal
    if (type === 'turn.completed' || (type === 'event_msg' && payloadType === 'task_complete')) {
      const exitCode = readNum(parsed, 'exit_code') ?? readNum(payload, 'exit_code') ?? 0;
      out.push({ seq: nextSeq(), ts, type: 'done', exitCode });
      continue;
    }
  }

  return out;
}
