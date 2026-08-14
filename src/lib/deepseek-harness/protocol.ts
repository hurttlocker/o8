import type {
  OwnedRunOutcome,
  OwnedTailEntry,
} from '@/lib/runtimes/shared/owned-session/types';
import { compactText, formatClock } from '@/lib/runtimes/shared/owned-session/helpers';

export const DEEPSEEK_HARNESS_SERVER_NAME = 'deepseek-harness-acp';

export type DeepSeekHarnessRunMode = 'launch' | 'resume';

export interface DeepSeekHarnessRunRecord {
  id: string;
  mode: DeepSeekHarnessRunMode;
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  outcome: OwnedRunOutcome;
  stdoutPath: string;
  stderrPath: string;
  pid?: number;
  commandIdentity?: string;
  messageId?: string;
  finishReason?: string;
  inboxAccepted?: boolean;
  idleSeen?: boolean;
}

export interface DeepSeekHarnessInitializeResult {
  protocolVersion: number;
  agentInfo: { name: string; version: string };
}

export interface DeepSeekHarnessNewSessionResult {
  sessionId: string;
}

export interface DeepSeekHarnessPromptResult {
  stopReason: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function textBlocks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((block) => {
    const item = record(block);
    if (!item) return [];
    if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
      return [item.text.trim()];
    }
    return [];
  });
}

export function validateDeepSeekHarnessInitialize(value: unknown): DeepSeekHarnessInitializeResult {
  const result = record(value);
  const agentInfo = record(result?.agentInfo);
  if (result?.protocolVersion !== 1
    || agentInfo?.name !== DEEPSEEK_HARNESS_SERVER_NAME
    || typeof agentInfo.version !== 'string'
    || !agentInfo.version.trim()) {
    throw new Error(
      `DeepSeek Harness initialize returned an incompatible server identity; expected ${DEEPSEEK_HARNESS_SERVER_NAME}.`,
    );
  }
  return {
    protocolVersion: 1,
    agentInfo: { name: DEEPSEEK_HARNESS_SERVER_NAME, version: agentInfo.version.trim() },
  };
}

export function validateDeepSeekHarnessNewSession(value: unknown): DeepSeekHarnessNewSessionResult {
  const result = record(value);
  if (typeof result?.sessionId !== 'string' || !result.sessionId.trim()) {
    throw new Error('DeepSeek Harness ACP session/new returned no sessionId.');
  }
  return { sessionId: result.sessionId.trim() };
}

export function validateDeepSeekHarnessPrompt(value: unknown): DeepSeekHarnessPromptResult {
  const result = record(value);
  if (typeof result?.stopReason !== 'string' || !result.stopReason.trim()) {
    throw new Error('DeepSeek Harness ACP session/prompt returned no stopReason.');
  }
  return { stopReason: result.stopReason.trim() };
}

export function deepSeekHarnessEvent(value: unknown): Record<string, unknown> | null {
  const params = record(value);
  return record(params?.event);
}

export function deepSeekHarnessInboxContains(event: Record<string, unknown>, messageId: string): boolean {
  if (event.type !== 'agent/inbox/spliced') return false;
  const data = record(event.data);
  return Array.isArray(data?.inserted) && data.inserted.some((item) => record(item)?.id === messageId);
}

export function deepSeekHarnessEventUsage(event: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string | null;
} | null {
  if (event.type !== 'assistant/message') return null;
  const data = record(event.data);
  const usage = record(data?.usage);
  if (!usage) return null;
  const message = record(data?.message);
  const source = record(message?.source);
  const result = {
    inputTokens: number(usage.inputTokens),
    outputTokens: number(usage.outputTokens),
    cacheReadTokens: number(usage.cacheReadTokens),
    cacheWriteTokens: number(usage.cacheWriteTokens),
    model: typeof source?.model === 'string' && source.model.trim() ? source.model.trim() : null,
  };
  return result.inputTokens || result.outputTokens || result.cacheReadTokens || result.cacheWriteTokens
    ? result
    : null;
}

export function parseDeepSeekHarnessRunLog(
  raw: string,
  run: DeepSeekHarnessRunRecord,
): { entries: OwnedTailEntry[]; completedTurn: boolean; finishReason?: string } {
  const entries: OwnedTailEntry[] = [{
    id: `${run.id}:prompt`,
    kind: 'event',
    label: run.mode === 'launch' ? 'Launch prompt' : 'Resume prompt',
    text: compactText(run.prompt, 400),
    timestamp: run.startedAt,
    timestampLabel: formatClock(run.startedAt),
  }];
  let completedTurn = false;
  let finishReason: string | undefined;

  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim().startsWith('{')) continue;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (frame.method === 'session/update') {
      const params = record(frame.params);
      const update = record(params?.update);
      const timestamp = run.finishedAt ?? run.startedAt;
      if (update?.sessionUpdate === 'agent_message_chunk') {
        const text = record(update.content)?.text;
        if (typeof text === 'string' && text.trim()) {
          entries.push({
            id: `${run.id}:assistant:${index}`,
            kind: 'message',
            label: 'DeepSeek Harness',
            text: compactText(text.trim(), 2_000),
            timestamp,
            timestampLabel: formatClock(timestamp),
          });
        }
      } else if (update?.sessionUpdate === 'tool_call') {
        entries.push({
          id: `${run.id}:tool:${update.toolCallId ?? index}`,
          kind: 'tool',
          label: typeof update.title === 'string' ? update.title : 'tool',
          text: compactText(JSON.stringify(update.rawInput ?? {}), 800),
          timestamp,
          timestampLabel: formatClock(timestamp),
        });
      } else if (update?.sessionUpdate === 'tool_call_update' && update.status === 'completed') {
        entries.push({
          id: `${run.id}:tool-result:${update.toolCallId ?? index}`,
          kind: 'tool-output',
          label: typeof update.title === 'string' ? update.title : 'tool result',
          text: compactText(textBlocks(update.content).join('\n') || JSON.stringify(update.content ?? {}), 800),
          timestamp,
          timestampLabel: formatClock(timestamp),
        });
      }
      continue;
    }
    if (frame.method === 'o8/session.prompt.settled') {
      const params = record(frame.params);
      completedTurn = params?.outcome === 'finished';
      finishReason = typeof params?.stopReason === 'string' ? params.stopReason : undefined;
      continue;
    }
    if (frame.method !== 'session.event') continue;
    const params = record(frame.params);
    const event = record(params?.event);
    if (!event) continue;
    const type = typeof event.type === 'string' ? event.type : 'unknown';
    const data = record(event.data);
    const timestamp = typeof event.time === 'number' && event.time > 0
      ? new Date(event.time).toISOString()
      : run.finishedAt ?? run.startedAt;

    if (type === 'assistant/message') {
      const message = record(data?.message);
      const blocks = Array.isArray(message?.content) ? message.content : [];
      const text = textBlocks(blocks).join('\n').trim();
      if (text) {
        entries.push({
          id: `${run.id}:assistant:${event.seq ?? index}`,
          kind: 'message',
          label: 'DeepSeek Harness',
          text: compactText(text, 2_000),
          timestamp,
          timestampLabel: formatClock(timestamp),
        });
      }
      for (const [blockIndex, block] of blocks.entries()) {
        const item = record(block);
        if (item?.type !== 'tool-call') continue;
        entries.push({
          id: `${run.id}:tool:${item.id ?? `${index}-${blockIndex}`}`,
          kind: 'tool',
          label: typeof item.name === 'string' ? item.name : 'tool',
          text: compactText(typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}), 800),
          timestamp,
          timestampLabel: formatClock(timestamp),
        });
      }
      continue;
    }

    if (type === 'turn/end') {
      completedTurn = true;
      const reason = record(data?.reason);
      finishReason = typeof reason?.kind === 'string' ? reason.kind : 'unknown';
      entries.push({
        id: `${run.id}:turn-end:${event.seq ?? index}`,
        kind: 'event',
        label: 'Turn ended',
        text: `DeepSeek Harness reported ${finishReason}.`,
        timestamp,
        timestampLabel: formatClock(timestamp),
      });
      continue;
    }

    if (type.includes('tool') && data) {
      entries.push({
        id: `${run.id}:${type}:${event.seq ?? index}`,
        kind: type.includes('result') || type.includes('output') ? 'tool-output' : 'event',
        label: type,
        text: compactText(JSON.stringify(data), 800),
        timestamp,
        timestampLabel: formatClock(timestamp),
      });
    }
  }

  return { entries, completedTurn, finishReason };
}
