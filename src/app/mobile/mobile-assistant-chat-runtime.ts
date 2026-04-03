'use client';

import type {
  ChatModelAdapter,
  ChatModelRunOptions,
  ThreadAssistantMessagePart,
  ThreadMessage,
  ThreadMessageLike,
} from '@assistant-ui/react';
import type { ReadonlyJSONObject, ReadonlyJSONValue } from 'assistant-stream/utils';
import { DEFAULT_MOBILE_CHAT_MODEL, type ChatMessage, type ChatToolPart, type ModelOption } from './mobile-approvals-shared';

export interface PersistedMobileChatMessage extends ChatMessage {
  thinking?: string;
  toolParts?: ChatToolPart[];
}

type PlainObject = ReadonlyJSONObject;

type MessagePart = {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: PlainObject;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
};

type StreamPayload = {
  type?: string;
  text?: string;
  name?: string;
  status?: string;
  args?: PlainObject;
  preview?: string;
  message?: string;
};

type MutableTextPart = {
  type: 'text';
  text: string;
};

type MutableToolCallPart = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: PlainObject;
  argsText: string;
  result?: ReadonlyJSONValue;
  isError?: boolean;
};

type MutableAssistantBlock = MutableTextPart | MutableToolCallPart;

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

function toJsonValue(value: unknown): ReadonlyJSONValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toJsonValue(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]),
    ) as ReadonlyJSONObject;
  }
  return String(value);
}

function normalizeObject(value: unknown): PlainObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]),
  ) as PlainObject;
}

function stringifyToolArgs(args: PlainObject) {
  return Object.keys(args).length > 0
    ? JSON.stringify(args, null, 2)
    : '{}';
}

function collectPartText(content: readonly MessagePart[], type: 'text' | 'reasoning') {
  return content.reduce((acc, part) => {
    if (part.type !== type || typeof part.text !== 'string') return acc;
    return acc + part.text;
  }, '');
}

function normalizeToolPart(part: ChatToolPart, index: number): MutableToolCallPart | null {
  const toolName = part.toolName?.trim();
  if (!toolName) return null;
  const args = normalizeObject(part.args);
  return {
    type: 'tool-call',
    toolCallId: part.toolCallId?.trim() || `persisted-tool-${index}`,
    toolName,
    args,
    argsText: part.argsText?.trim() || stringifyToolArgs(args),
    ...(part.result !== undefined ? { result: toJsonValue(part.result) } : {}),
    ...(part.isError ? { isError: true } : {}),
  };
}

export function getMessageTextContent(content: readonly MessagePart[]) {
  return collectPartText(content, 'text');
}

export function getMessageThinkingBlocks(content: readonly MessagePart[]) {
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

export function getMessageToolParts(content: readonly MessagePart[]) {
  return content.reduce<ChatToolPart[]>((parts, part, index) => {
    if (part.type !== 'tool-call' || !part.toolName?.trim()) return parts;
    const args = normalizeObject(part.args);
    parts.push({
      toolCallId: part.toolCallId?.trim() || `message-tool-${index}`,
      toolName: part.toolName,
      ...(Object.keys(args).length > 0 ? { args } : {}),
      ...(part.argsText?.trim() ? { argsText: part.argsText } : {}),
      ...(part.result !== undefined ? { result: part.result } : {}),
      ...(part.isError ? { isError: true } : {}),
    });
    return parts;
  }, []);
}

function extractUserMessageContent(message: ThreadMessage) {
  return getMessageTextContent(message.content);
}

function extractAssistantContent(message: ThreadMessage) {
  return {
    content: getMessageTextContent(message.content),
    thinking: getMessageThinkingBlocks(message.content).join('\n\n'),
    toolParts: getMessageToolParts(message.content),
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

function consumeSseBuffer(buffer: string, flush = false) {
  const lines = buffer.split('\n');
  const remainder = flush ? '' : (lines.pop() ?? '');
  const updates: StreamPayload[] = [];

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;

    try {
      const parsed = JSON.parse(payload) as StreamPayload;
      updates.push(parsed);
    } catch {
      // Ignore malformed SSE payloads.
    }
  }

  return { remainder, updates };
}

function appendTextBlock(blocks: MutableAssistantBlock[], text: string) {
  const lastBlock = blocks[blocks.length - 1];
  if (lastBlock?.type === 'text') {
    lastBlock.text += text;
    return;
  }
  blocks.push({ type: 'text', text });
}

function findPendingToolIndex(blocks: MutableAssistantBlock[], toolName: string) {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.type !== 'tool-call') continue;
    if (block.toolName === toolName && block.result === undefined) {
      return index;
    }
  }
  return -1;
}

function ensureToolBlock(
  blocks: MutableAssistantBlock[],
  toolName: string,
  nextToolId: () => string,
  args?: PlainObject,
  status?: string,
) {
  const nextArgs = normalizeObject(args);

  if (status === 'calling') {
    blocks.push({
      type: 'tool-call',
      toolCallId: nextToolId(),
      toolName,
      args: nextArgs,
      argsText: stringifyToolArgs(nextArgs),
    });
    return;
  }

  const pendingIndex = findPendingToolIndex(blocks, toolName);

  if (pendingIndex >= 0) {
    const pending = blocks[pendingIndex] as MutableToolCallPart;
    if (Object.keys(nextArgs).length > 0) {
      pending.args = nextArgs;
      pending.argsText = stringifyToolArgs(nextArgs);
    }
    return;
  }

  blocks.push({
    type: 'tool-call',
    toolCallId: nextToolId(),
    toolName,
    args: nextArgs,
    argsText: stringifyToolArgs(nextArgs),
  });
}

function completeToolBlock(
  blocks: MutableAssistantBlock[],
  toolName: string,
  nextToolId: () => string,
  result: ReadonlyJSONValue,
  isError = false,
) {
  const pendingIndex = findPendingToolIndex(blocks, toolName);
  if (pendingIndex >= 0) {
    const pending = blocks[pendingIndex] as MutableToolCallPart;
    pending.result = result;
    pending.isError = isError;
    return;
  }

  blocks.push({
    type: 'tool-call',
    toolCallId: nextToolId(),
    toolName,
    args: {},
    argsText: '{}',
    result,
    ...(isError ? { isError: true } : {}),
  });
}

function buildAssistantSnapshot(
  thinkingText: string,
  blocks: readonly MutableAssistantBlock[],
): ThreadAssistantMessagePart[] {
  const content: ThreadAssistantMessagePart[] = [];

  if (thinkingText.trim()) {
    content.push({ type: 'reasoning', text: thinkingText });
  }

  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text) {
        content.push({ type: 'text', text: block.text });
      }
      continue;
    }

    content.push({
      type: 'tool-call',
      toolCallId: block.toolCallId,
      toolName: block.toolName,
      args: block.args,
      argsText: block.argsText,
      ...(block.result !== undefined ? { result: block.result } : {}),
      ...(block.isError ? { isError: true } : {}),
    });
  }

  return content;
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

    const toolParts = (message.toolParts ?? [])
      .map((part, index) => normalizeToolPart(part, index))
      .filter((part): part is MutableToolCallPart => part !== null);
    if (toolParts.length > 0) {
      content.push(...toolParts);
    }

    if (message.content.trim()) {
      content.push({ type: 'text', text: message.content });
    }

    if (content.length === 0) return acc;

    acc.push({
      role: 'assistant',
      content,
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
    if (!assistant.content.trim() && !assistant.thinking.trim() && assistant.toolParts.length === 0) return acc;

    acc.push({
      role: 'assistant',
      content: assistant.content,
      ...(assistant.thinking.trim() ? { thinking: assistant.thinking } : {}),
      ...(assistant.toolParts.length > 0 ? { toolParts: assistant.toolParts } : {}),
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
        const blocks: MutableAssistantBlock[] = [];
        let sawRenderablePart = false;
        let toolCount = 0;

        const nextToolId = () => `mobile-tool-${toolCount++}`;
        const emitSnapshot = () => ({ content: buildAssistantSnapshot(thinkingText, blocks) });
        const applyUpdate = (update: StreamPayload) => {
          if (update.type === 'thinking' && update.text) {
            thinkingText += update.text;
            return emitSnapshot();
          }

          if (update.type === 'content' && update.text) {
            sawRenderablePart = true;
            appendTextBlock(blocks, update.text);
            return emitSnapshot();
          }

          if (update.type === 'tool_call' && update.name) {
            sawRenderablePart = true;
            ensureToolBlock(blocks, update.name, nextToolId, update.args, update.status);
            return emitSnapshot();
          }

          if (update.type === 'tool_result' && update.name) {
            sawRenderablePart = true;
            const toolResult = toJsonValue({
              ...(update.status ? { status: update.status } : {}),
              ...(typeof update.preview === 'string' ? { preview: update.preview } : {}),
            });
            const isError = update.status === 'blocked' || update.status === 'error';
            completeToolBlock(blocks, update.name, nextToolId, toolResult, isError);
            return emitSnapshot();
          }

          if (update.type === 'error' && update.message) {
            throw new Error(update.message);
          }

          return null;
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parsed = consumeSseBuffer(buffer);
          buffer = parsed.remainder;

          for (const update of parsed.updates) {
            const snapshot = applyUpdate(update);
            if (snapshot) {
              yield snapshot;
            }
          }
        }

        buffer += decoder.decode();
        const parsed = consumeSseBuffer(buffer, true);
        for (const update of parsed.updates) {
          const snapshot = applyUpdate(update);
          if (snapshot) {
            yield snapshot;
          }
        }

        if (!sawRenderablePart) {
          yield {
            content: [{ type: 'text', text: 'No response received.' }],
            status: { type: 'complete', reason: 'stop' },
          };
        }
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }

        yield createAssistantError(
          'Something went wrong while streaming the response.',
          error instanceof Error ? error.message : 'Unknown stream error.',
        );
      }
    },
  };
}
