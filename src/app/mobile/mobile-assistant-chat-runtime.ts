'use client';

import type {
  ChatModelAdapter,
  ChatModelRunOptions,
  ThreadAssistantMessagePart,
  ThreadMessage,
  ThreadMessageLike,
} from '@assistant-ui/react';
import { DEFAULT_MOBILE_CHAT_MODEL, type ChatMessage, type ModelOption } from './mobile-approvals-shared';

export interface PersistedMobileChatMessage extends ChatMessage {
  thinking?: string;
}

type TextualPart = {
  type: string;
  text?: string;
};

type StreamPayload = {
  type?: string;
  text?: string;
};

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

function collectPartText(content: readonly TextualPart[], type: 'text' | 'reasoning') {
  return content.reduce((acc, part) => {
    if (part.type !== type || typeof part.text !== 'string') return acc;
    return acc + part.text;
  }, '');
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

function extractUserMessageContent(message: ThreadMessage) {
  return getMessageTextContent(message.content);
}

function extractAssistantContent(message: ThreadMessage) {
  return {
    content: getMessageTextContent(message.content),
    thinking: getMessageThinkingBlocks(message.content).join('\n\n'),
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

function buildAssistantSnapshot(thinkingText: string, contentText: string): ThreadAssistantMessagePart[] {
  const content: ThreadAssistantMessagePart[] = [];

  if (thinkingText.trim()) {
    content.push({ type: 'reasoning', text: thinkingText });
  }
  if (contentText.trim()) {
    content.push({ type: 'text', text: contentText });
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
    if (!assistant.content.trim() && !assistant.thinking.trim()) return acc;

    acc.push({
      role: 'assistant',
      content: assistant.content,
      ...(assistant.thinking.trim() ? { thinking: assistant.thinking } : {}),
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

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parsed = consumeSseBuffer(buffer);
          buffer = parsed.remainder;

          for (const update of parsed.updates) {
            if (update.type === 'thinking' && update.text) {
              thinkingText += update.text;
              yield { content: buildAssistantSnapshot(thinkingText, contentText) };
            } else if (update.type === 'content' && update.text) {
              sawContent = true;
              contentText += update.text;
              yield { content: buildAssistantSnapshot(thinkingText, contentText) };
            }
          }
        }

        buffer += decoder.decode();
        const parsed = consumeSseBuffer(buffer, true);
        for (const update of parsed.updates) {
          if (update.type === 'thinking' && update.text) {
            thinkingText += update.text;
            yield { content: buildAssistantSnapshot(thinkingText, contentText) };
          } else if (update.type === 'content' && update.text) {
            sawContent = true;
            contentText += update.text;
            yield { content: buildAssistantSnapshot(thinkingText, contentText) };
          }
        }

        if (!sawContent) {
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
