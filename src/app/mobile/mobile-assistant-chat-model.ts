'use client';

import type {
  ChatModelAdapter,
  ChatModelRunOptions,
  ThreadAssistantMessagePart,
} from '@assistant-ui/react';
import {
  DEFAULT_MOBILE_CHAT_MODEL,
  type MobileChatToolCall,
  type MobileChatToolResult,
  type MobileChatToolStatus,
  type ModelOption,
} from './mobile-approvals-shared';
import {
  createAssistantError,
  extractToolFilePath,
  hasToolArguments,
  hasToolResult,
  isAbortError,
  isToolCallPending,
  isRecord,
  normalizeToolArguments,
  readString,
  readToolStatus,
  toAssistantUiToolCallPart,
  toProxyMessages,
} from './mobile-assistant-chat-core';

type ContentEvent = {
  type: 'content';
  text: string;
};

type ThinkingEvent = {
  type: 'thinking';
  text: string;
};

interface ToolUseEvent {
  type: 'tool_use';
  toolName: string;
  arguments: Record<string, unknown>;
  filePath?: string;
  status?: Extract<MobileChatToolStatus, 'calling' | 'running'>;
  toolCallId?: string;
}

interface ToolResultEvent {
  type: 'tool_result';
  output?: string;
  diff?: unknown;
  status?: MobileChatToolStatus;
  toolName?: string;
  toolCallId?: string;
}

type StreamErrorEvent = {
  type: 'error';
  text: string;
};

type StreamPayload = ContentEvent | ThinkingEvent | ToolUseEvent | ToolResultEvent | StreamErrorEvent;

export async function readMobileProxyError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  if (typeof payload?.error === 'string' && payload.error.trim()) {
    return payload.error.trim();
  }
  return `The selected runtime could not answer (HTTP ${response.status || 500}).`;
}

function normalizeStreamPayload(payload: unknown): StreamPayload | null {
  if (!isRecord(payload)) return null;

  if (payload.type === 'content' && typeof payload.text === 'string') {
    return { type: 'content', text: payload.text };
  }

  if (payload.type === 'thinking' && typeof payload.text === 'string') {
    return { type: 'thinking', text: payload.text };
  }

  // The proxy emits the same reason under `message` and `text`; dropping the event
  // turned every runtime failure into a bare "No response received."
  if (payload.type === 'error') {
    const text = readString(payload.message) ?? readString(payload.text);
    if (!text) return null;
    return { type: 'error', text };
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

export function createMobileChatModel(selectedModel: ModelOption, repoPath: string | null, effortOverride?: string): ChatModelAdapter {
  return {
    run: async function* ({ messages, abortSignal }: ChatModelRunOptions) {
      try {
        const isCli = selectedModel.backend === 'cli' && selectedModel.cliRuntime;
        const endpoint = isCli ? '/api/v2/proxy/cli' : '/api/v2/proxy/llm';
        const effort = effortOverride || selectedModel.defaultEffort;
        const body = isCli
          ? {
              runtime: selectedModel.cliRuntime,
              model: selectedModel.id,
              messages: toProxyMessages(messages),
              ...(effort ? { effort } : {}),
              ...(repoPath ? { repoPath } : {}),
            }
          : {
              model: selectedModel.id || DEFAULT_MOBILE_CHAT_MODEL,
              provider: selectedModel.provider,
              messages: toProxyMessages(messages),
              stream: true,
              repoPath,
            };

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abortSignal,
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const message = await readMobileProxyError(response);
          yield createAssistantError(
            message,
            `Mobile proxy request failed with status ${response.status || 500}.`,
          );
          return;
        }
        if (!response.body) {
          yield createAssistantError(
            'The selected runtime returned an empty response.',
            'Mobile proxy response body was empty.',
          );
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let thinkingText = '';
        let contentText = '';
        let sawContent = false;
        let streamError: string | null = null;
        let nextToolCallIndex = 0;
        const toolCalls: MobileChatToolCall[] = [];

        const applyUpdate = (update: StreamPayload) => {
          if (update.type === 'error') {
            streamError = update.text;
            return false;
          }

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

        if (streamError) {
          yield createAssistantError(streamError, streamError);
          return;
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
