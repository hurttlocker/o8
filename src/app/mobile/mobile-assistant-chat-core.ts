'use client';

import type {
  ThreadAssistantMessagePart,
  ThreadMessage,
} from '@assistant-ui/react';
import type {
  MobileChatToolCall,
  MobileChatToolResult,
  MobileChatToolStatus,
} from './mobile-approvals-shared';

export type TextualPart = {
  type: string;
  text?: string;
};

export type ToolPartLike = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  artifact?: unknown;
  isError?: boolean;
};

type ToolCallArtifact = {
  filePath?: string;
  status?: MobileChatToolStatus;
};

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

export function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function readToolStatus(value: unknown): MobileChatToolStatus | undefined {
  return value === 'calling'
    || value === 'running'
    || value === 'done'
    || value === 'blocked'
    || value === 'error'
    ? value
    : undefined;
}

export function normalizeToolArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;

  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      return { value };
    }
  }

  return {};
}

function stringifyToolArguments(argumentsValue: Record<string, unknown>) {
  return JSON.stringify(argumentsValue);
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }

  if (isRecord(value)) {
    return Object.entries(value).reduce<JsonObject>((acc, [key, entry]) => {
      if (entry === undefined) return acc;
      acc[key] = toJsonValue(entry);
      return acc;
    }, {});
  }

  return String(value);
}

function toJsonObject(argumentsValue: Record<string, unknown> | undefined): JsonObject {
  return Object.entries(argumentsValue ?? {}).reduce<JsonObject>((acc, [key, value]) => {
    if (value === undefined) return acc;
    acc[key] = toJsonValue(value);
    return acc;
  }, {});
}

export function normalizeToolResult(value: unknown): MobileChatToolResult | undefined {
  if (typeof value === 'string') {
    return value.trim() ? { output: value } : undefined;
  }

  if (!isRecord(value)) return undefined;

  const output = readString(value.output) ?? readString(value.preview);
  const status = readToolStatus(value.status);
  const diff = Object.prototype.hasOwnProperty.call(value, 'diff') ? value.diff : undefined;

  if (!output?.trim() && diff === undefined && !status) return undefined;

  return {
    ...(output?.trim() ? { output } : {}),
    ...(diff !== undefined ? { diff } : {}),
    ...(status ? { status } : {}),
  };
}

export function hasToolResult(result: MobileChatToolResult | undefined): result is MobileChatToolResult {
  return !!result && (!!result.output?.trim() || result.diff !== undefined || !!result.status);
}

export function hasToolArguments(argumentsValue: Record<string, unknown>) {
  return Object.keys(argumentsValue).length > 0;
}

export function extractToolFilePath(argumentsValue: Record<string, unknown>, fallback?: string) {
  return readString(argumentsValue.path) ?? fallback;
}

export function isToolCallPending(toolCall: MobileChatToolCall) {
  const status = toolCall.result?.status ?? toolCall.status;
  if (status === 'done' || status === 'blocked' || status === 'error') return false;
  return true;
}

function collectPartText(content: readonly TextualPart[], type: 'text' | 'reasoning') {
  return content.reduce((acc, part) => {
    if (part.type !== type || typeof part.text !== 'string') return acc;
    return acc + part.text;
  }, '');
}

export function toAssistantUiToolCallPart(toolCall: MobileChatToolCall): ThreadAssistantMessagePart {
  const artifact: ToolCallArtifact | undefined = toolCall.filePath || toolCall.status
    ? {
        ...(toolCall.filePath ? { filePath: toolCall.filePath } : {}),
        ...(toolCall.status ? { status: toolCall.status } : {}),
      }
    : undefined;
  const jsonArgs = toJsonObject(toolCall.arguments);

  return {
    type: 'tool-call',
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    args: jsonArgs,
    argsText: stringifyToolArguments(jsonArgs),
    ...(artifact ? { artifact } : {}),
    ...(hasToolResult(toolCall.result) ? { result: toolCall.result } : {}),
    ...(toolCall.isError ? { isError: true } : {}),
  };
}

export function getMessageTextContent(content: readonly TextualPart[]) {
  return collectPartText(content, 'text');
}

export function getMessageThinkingBlocks(content: readonly TextualPart[]) {
  const blocks: string[] = [];
  let buffer = '';

  for (const part of content) {
    if (part.type === 'reasoning' && typeof part.text === 'string') {
      buffer += part.text;
      continue;
    }

    if (buffer.trim()) {
      blocks.push(buffer);
    }
    buffer = '';
  }

  if (buffer.trim()) {
    blocks.push(buffer);
  }

  return blocks;
}

export function getMessageToolCalls(content: readonly ToolPartLike[]): MobileChatToolCall[] {
  return content.reduce<MobileChatToolCall[]>((acc, part) => {
    if (part.type !== 'tool-call' || !part.toolName || !part.toolCallId) return acc;

    const argumentsValue = normalizeToolArguments(part.args);
    const artifact = isRecord(part.artifact) ? part.artifact : null;
    const filePath = readString(artifact?.filePath) ?? extractToolFilePath(argumentsValue);
    const status = readToolStatus(artifact?.status);
    const result = normalizeToolResult(part.result);

    acc.push({
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      ...(hasToolArguments(argumentsValue) ? { arguments: argumentsValue } : {}),
      ...(filePath ? { filePath } : {}),
      ...((result?.status ?? status) ? { status: result?.status ?? status } : {}),
      ...(result ? { result } : {}),
      ...(part.isError === true ? { isError: true } : {}),
    });

    return acc;
  }, []);
}

export function extractUserMessageContent(message: ThreadMessage) {
  return getMessageTextContent(message.content);
}

export function extractAssistantContent(message: ThreadMessage) {
  return {
    content: getMessageTextContent(message.content),
    thinking: getMessageThinkingBlocks(message.content).join('\n\n'),
    toolCalls: getMessageToolCalls(message.content),
  };
}

export function toProxyMessages(messages: readonly ThreadMessage[]) {
  return messages
    .filter((message) => message.role === 'system' || message.role === 'user' || message.role === 'assistant')
    .map((message) => {
      const content = message.role === 'assistant'
        ? extractAssistantContent(message).content
        : extractUserMessageContent(message);

      return {
        role: message.role,
        content,
      };
    })
    .filter((message) => message.role === 'system' || message.content.trim().length > 0);
}

export function createAssistantError(content: string, error: string): {
  content: readonly ThreadAssistantMessagePart[];
  status: { type: 'incomplete'; reason: 'error'; error: string };
} {
  return {
    content: [{ type: 'text', text: content }],
    status: { type: 'incomplete', reason: 'error', error },
  };
}
