'use client';

import type {
  ThreadAssistantMessagePart,
  ThreadMessage,
  ThreadMessageLike,
} from '@assistant-ui/react';
import type { ChatMessage } from './mobile-approvals-shared';
import {
  extractAssistantContent,
  extractUserMessageContent,
  toAssistantUiToolCallPart,
} from './mobile-assistant-chat-core';

export { createMobileChatModel } from './mobile-assistant-chat-model';
export { getMessageTextContent, getMessageThinkingBlocks, getMessageToolCalls } from './mobile-assistant-chat-core';

export type PersistedMobileChatMessage = ChatMessage;

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
