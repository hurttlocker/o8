'use client';

import type {
  ChatModelAdapter,
  ChatModelRunOptions,
  ThreadAssistantMessagePart,
  ThreadMessage,
  ThreadMessageLike,
} from '@assistant-ui/react';
import {
  DEFAULT_MOBILE_CHAT_MODEL,
  type ChatMessage,
  type MobileChatToolCall,
  type MobileChatToolResult,
  type MobileChatToolStatus,
  type ModelOption,
} from './mobile-approvals-shared';

export type PersistedMobileChatMessage = ChatMessage;

type TextualPart = {
  type: string;
  text?: string;
};

type ToolPartLike = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  artifact?: unknown;
  isError?: boolean;
};

type ContentEvent = {
  type: 'content';
  text: string;
};

type ThinkingEvent = {
  type: 'thinking';
  text: string;
};

export interface ToolUseEvent {
  type: 'tool_use';
  toolName: string;
  arguments: Record<string, unknown>;
  filePath?: string;
  status?: Extract<MobileChatToolStatus, 'calling' | 'running'>;
  toolCallId?: string;
}

export interface ToolResultEvent {
  type: 'tool_result';
  output?: string;
  diff?: unknown;
  status?: MobileChatToolStatus;
  toolName?: string;
  toolCallId?: string;
}

type StreamPayload = ContentEvent | ThinkingEvent | ToolUseEvent | ToolResultEvent;

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

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readToolStatus(value: unknown): MobileChatToolStatus | undefined {
  return value === 'calling'
    || value === 'running'
    || value === 'done'
    || value === 'blocked'
    || value === 'error'
    ? value
    : undefined;
}

function normalizeToolArguments(value: unknown): Record<string, unknown> {
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

function normalizeToolResult(value: unknown): MobileChatToolResult | undefined {
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

function hasToolResult(result: MobileChatToolResult | undefined): result is MobileChatToolResult {
  return !!result && (!!result.output?.trim() || result.diff !== undefined || !!result.status);
}

function hasToolArguments(argumentsValue: Record<string, unknown>) {
  return Object.keys(argumentsValue).length > 0;
}

function extractToolFilePath(argumentsValue: Record<string, unknown>, fallback?: string) {
  return readString(argumentsValue.path) ?? fallback;
}

function isToolCallPending(toolCall: MobileChatToolCall) {
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

function toAssistantUiToolCallPart(toolCall: MobileChatToolCall): ThreadAssistantMessagePart {
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

function extractUserMessageContent(message: ThreadMessage) {
  return getMessageTextContent(message.content);
}

function extractAssistantContent(message: ThreadMessage) {
  return {
    content: getMessageTextContent(message.content),
    thinking: getMessageThinkingBlocks(message.content).join('\n\n'),
    toolCalls: getMessageToolCalls(message.content),
  };
}

function toProxyMessages(messages: readonly ThreadMessage[]) {
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

function createAssistantError(content: string, error: string): {
  content: readonly ThreadAssistantMessagePart[];
  status: { type: 'incomplete'; reason: 'error'; error: string };
} {
  return {
    content: [{ type: 'text', text: content }],
    status: { type: 'incomplete', reason: 'error', error },
  };
}

function normalizeStreamPayload(payload: unknown): StreamPayload | null {
  if (!isRecord(payload)) return null;

  if (payload.type === 'content' && typeof payload.text === 'string') {
    return { type: 'content', text: payload.text };
  }

  if (payload.type === 'thinking' && typeof payload.text === 'string') {
    return { type: 'thinking', text: payload.text };
  }

  if (payload.type === 'tool_use') {
    const toolName = readString(payload.toolName);
    if (!toolName) return null;

    const argumentsValue = normalizeToolArguments(payload.arguments);
    const filePath = readString(payload.filePath) ?? extractToolFilePath(argumentsValue);
    const status = readToolStatus(payload.status);

    return {
      type: 'tool_use',
      toolName,
      arguments: argumentsValue,
      ...(filePath ? { filePath } : {}),
      ...((status === 'calling' || status === 'running') ? { status } : {}),
      ...(readString(payload.toolCallId) ? { toolCallId: readString(payload.toolCallId) } : {}),
    };
  }

  if (payload.type === 'tool_call') {
    const toolName = readString(payload.toolName) ?? readString(payload.name);
    if (!toolName) return null;

    const argumentsValue = normalizeToolArguments(
      Object.prototype.hasOwnProperty.call(payload, 'arguments')
        ? payload.arguments
        : payload.args,
    );
    const filePath = readString(payload.filePath) ?? extractToolFilePath(argumentsValue);
    const status = readToolStatus(payload.status);

    return {
      type: 'tool_use',
      toolName,
      arguments: argumentsValue,
      ...(filePath ? { filePath } : {}),
      ...((status === 'calling' || status === 'running') ? { status } : {}),
      ...(readString(payload.toolCallId) ? { toolCallId: readString(payload.toolCallId) } : {}),
    };
  }

  if (payload.type === 'tool_result') {
    const output = readString(payload.output) ?? readString(payload.preview);
    const status = readToolStatus(payload.status);
    const diff = Object.prototype.hasOwnProperty.call(payload, 'diff') ? payload.diff : undefined;
    const toolName = readString(payload.toolName) ?? readString(payload.name);
    const toolCallId = readString(payload.toolCallId);

    if (!output?.trim() && diff === undefined && !status && !toolName && !toolCallId) {
      return null;
    }

    return {
      type: 'tool_result',
      ...(output?.trim() ? { output } : {}),
      ...(diff !== undefined ? { diff } : {}),
      ...(status ? { status } : {}),
      ...(toolName ? { toolName } : {}),
      ...(toolCallId ? { toolCallId } : {}),
    };
  }

  return null;
}

function consumeSseBuffer(buffer: string, flush = false) {
  const lines = buffer.split('\n');
  const remainder = flush ? '' : (lines.pop() ?? '');
  const updates: StreamPayload[] = [];

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;

    try {
      const normalized = normalizeStreamPayload(JSON.parse(payload) as unknown);
      if (normalized) {
        updates.push(normalized);
      }
    } catch {
      // Ignore malformed SSE payloads.
    }
  }

  return { remainder, updates };
}

function findToolCallIndexById(toolCalls: MobileChatToolCall[], toolCallId?: string) {
  if (!toolCallId) return -1;
  return toolCalls.findIndex((toolCall) => toolCall.toolCallId === toolCallId);
}

function findPendingToolCallIndexByName(toolCalls: MobileChatToolCall[], toolName?: string) {
  if (!toolName) return -1;

  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    if (toolCall.toolName === toolName && isToolCallPending(toolCall)) {
      return index;
    }
  }

  return -1;
}

function upsertToolUse(
  toolCalls: MobileChatToolCall[],
  event: ToolUseEvent,
  nextToolCallIndex: number,
) {
  const byIdIndex = findToolCallIndexById(toolCalls, event.toolCallId);
  const existingIndex = byIdIndex >= 0 ? byIdIndex : findPendingToolCallIndexByName(toolCalls, event.toolName);
  const nextStatus = event.status ?? 'calling';

  if (existingIndex >= 0) {
    const existing = toolCalls[existingIndex];
    toolCalls[existingIndex] = {
      ...existing,
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      toolName: event.toolName,
      ...(hasToolArguments(event.arguments) ? { arguments: event.arguments } : {}),
      ...(event.filePath ? { filePath: event.filePath } : {}),
      status: nextStatus,
      ...(existing.result ? { result: existing.result } : {}),
    };
    return nextToolCallIndex;
  }

  toolCalls.push({
    toolCallId: event.toolCallId ?? `mobile-tool-call-${nextToolCallIndex}`,
    toolName: event.toolName,
    ...(hasToolArguments(event.arguments) ? { arguments: event.arguments } : {}),
    ...(event.filePath ? { filePath: event.filePath } : {}),
    status: nextStatus,
  });

  return nextToolCallIndex + 1;
}

function findToolCallForResult(toolCalls: MobileChatToolCall[], event: ToolResultEvent) {
  const byIdIndex = findToolCallIndexById(toolCalls, event.toolCallId);
  if (byIdIndex >= 0) return byIdIndex;

  const pendingByNameIndex = findPendingToolCallIndexByName(toolCalls, event.toolName);
  if (pendingByNameIndex >= 0) return pendingByNameIndex;

  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    if (event.toolName && toolCall.toolName === event.toolName) {
      return index;
    }
  }

  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    if (isToolCallPending(toolCalls[index])) {
      return index;
    }
  }

  return -1;
}

function applyToolResult(
  toolCalls: MobileChatToolCall[],
  event: ToolResultEvent,
  nextToolCallIndex: number,
) {
  const result: MobileChatToolResult | undefined = hasToolResult({
    ...(event.output?.trim() ? { output: event.output } : {}),
    ...(event.diff !== undefined ? { diff: event.diff } : {}),
    ...(event.status ? { status: event.status } : {}),
  })
    ? {
        ...(event.output?.trim() ? { output: event.output } : {}),
        ...(event.diff !== undefined ? { diff: event.diff } : {}),
        ...(event.status ? { status: event.status } : {}),
      }
    : undefined;

  const existingIndex = findToolCallForResult(toolCalls, event);
  if (existingIndex >= 0) {
    const existing = toolCalls[existingIndex];
    toolCalls[existingIndex] = {
      ...existing,
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      ...(event.toolName ? { toolName: event.toolName } : {}),
      ...(event.status ? { status: event.status } : {}),
      ...(result ? { result: { ...(existing.result ?? {}), ...result } } : {}),
      ...((event.status === 'blocked' || event.status === 'error') ? { isError: true } : {}),
    };
    return nextToolCallIndex;
  }

  if (!event.toolName) {
    return nextToolCallIndex;
  }

  toolCalls.push({
    toolCallId: event.toolCallId ?? `mobile-tool-call-${nextToolCallIndex}`,
    toolName: event.toolName,
    ...(event.status ? { status: event.status } : {}),
    ...(result ? { result } : {}),
    ...((event.status === 'blocked' || event.status === 'error') ? { isError: true } : {}),
  });

  return nextToolCallIndex + 1;
}

function buildAssistantSnapshot(
  thinkingText: string,
  toolCalls: MobileChatToolCall[],
  contentText: string,
): ThreadAssistantMessagePart[] {
  const content: ThreadAssistantMessagePart[] = [];

  if (thinkingText.trim()) {
    content.push({ type: 'reasoning', text: thinkingText });
  }

  for (const toolCall of toolCalls) {
    content.push(toAssistantUiToolCallPart(toolCall));
  }

  if (contentText.trim()) {
    content.push({ type: 'text', text: contentText });
  }

  return content;
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

export function toAssistantUiMessages(messages: PersistedMobileChatMessage[]): ThreadMessageLike[] {
  return messages.reduce<ThreadMessageLike[]>((acc, message) => {
    if (message.role === 'user') {
      if (!message.content.trim()) return acc;
      acc.push({
        role: 'user',
        content: [{ type: 'text', text: message.content }],
        attachments: [],
        metadata: { custom: {} },
      });
      return acc;
    }

    const content: ThreadAssistantMessagePart[] = [];
    if (message.thinking?.trim()) {
      content.push({ type: 'reasoning', text: message.thinking });
    }
    if (Array.isArray(message.toolCalls)) {
      content.push(...message.toolCalls.map(toAssistantUiToolCallPart));
    }
    if (message.content.trim()) {
      content.push({ type: 'text', text: message.content });
    }
    if (content.length === 0) return acc;

    acc.push({
      role: 'assistant',
      content,
      status: { type: 'complete', reason: 'stop' },
      metadata: { custom: {} },
    });
    return acc;
  }, []);
}

export function toPersistedChatMessages(messages: readonly ThreadMessage[]): PersistedMobileChatMessage[] {
  return messages.reduce<PersistedMobileChatMessage[]>((acc, message) => {
    if (message.role === 'system') return acc;

    if (message.role === 'user') {
      const content = extractUserMessageContent(message);
      if (!content.trim()) return acc;
      acc.push({ role: 'user', content });
      return acc;
    }

    const assistant = extractAssistantContent(message);
    if (!assistant.content.trim() && !assistant.thinking.trim() && assistant.toolCalls.length === 0) return acc;

    acc.push({
      role: 'assistant',
      content: assistant.content,
      ...(assistant.thinking.trim() ? { thinking: assistant.thinking } : {}),
      ...(assistant.toolCalls.length > 0 ? { toolCalls: assistant.toolCalls } : {}),
    });
    return acc;
  }, []);
}

export function createMobileChatModel(selectedModel: ModelOption): ChatModelAdapter {
  return {
    run: async function* ({ messages, abortSignal }: ChatModelRunOptions) {
      try {
        const response = await fetch('/api/v2/proxy/llm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abortSignal,
          body: JSON.stringify({
            model: selectedModel.id || DEFAULT_MOBILE_CHAT_MODEL,
            provider: selectedModel.provider,
            messages: toProxyMessages(messages),
            stream: true,
          }),
        });

        if (!response.ok || !response.body) {
          yield createAssistantError(
            'Failed to get a response. Check your API keys.',
            `LLM proxy request failed with status ${response.status || 500}.`,
          );
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let thinkingText = '';
        let contentText = '';
        let sawContent = false;
        let nextToolCallIndex = 0;
        const toolCalls: MobileChatToolCall[] = [];

        const applyUpdate = (update: StreamPayload) => {
          if (update.type === 'thinking') {
            if (!update.text) return false;
            thinkingText += update.text;
            return true;
          }

          if (update.type === 'content') {
            if (!update.text) return false;
            sawContent = true;
            contentText += update.text;
            return true;
          }

          if (update.type === 'tool_use') {
            nextToolCallIndex = upsertToolUse(toolCalls, update, nextToolCallIndex);
            return true;
          }

          nextToolCallIndex = applyToolResult(toolCalls, update, nextToolCallIndex);
          return true;
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parsed = consumeSseBuffer(buffer);
          buffer = parsed.remainder;

          for (const update of parsed.updates) {
            if (!applyUpdate(update)) continue;
            yield { content: buildAssistantSnapshot(thinkingText, toolCalls, contentText) };
          }
        }

        buffer += decoder.decode();
        const parsed = consumeSseBuffer(buffer, true);
        for (const update of parsed.updates) {
          if (!applyUpdate(update)) continue;
          yield { content: buildAssistantSnapshot(thinkingText, toolCalls, contentText) };
        }

        if (!sawContent && toolCalls.length === 0) {
          yield {
            content: [{ type: 'text', text: 'No response received.' }],
            status: { type: 'complete', reason: 'stop' },
          };
          return;
        }

        yield { status: { type: 'complete', reason: 'stop' } };
      } catch (error) {
        if (abortSignal.aborted || isAbortError(error)) {
          throw error;
        }

        yield createAssistantError(
          'Connection error. Is the server running?',
          error instanceof Error ? error.message : 'Unknown network error',
        );
      }
    },
  };
}
