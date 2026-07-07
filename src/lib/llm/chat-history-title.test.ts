import { describe, expect, it } from 'vitest';
import { resolvePersistedChatHistoryTitle } from './chat-history-title';

describe('chat history title persistence', () => {
  it('preserves an existing title over incoming autosave titles', () => {
    expect(resolvePersistedChatHistoryTitle({
      tabId: 'thoughts-1751587200000',
      existingTitle: 'Operator title',
      incomingTitle: 'The latest prompt text',
    })).toBe('Operator title');
  });

  it('does not persist raw prompt titles for orchestrator autosaves', () => {
    expect(resolvePersistedChatHistoryTitle({
      tabId: 'thoughts-1751587200000',
      existingTitle: null,
      incomingTitle: 'The hygiene packet is awaiting review. Review the diff properly.',
    })).toBeNull();
  });

  it('keeps incoming titles for normal chat threads', () => {
    expect(resolvePersistedChatHistoryTitle({
      tabId: 'chat-1',
      existingTitle: null,
      incomingTitle: 'Normal chat',
    })).toBe('Normal chat');
  });
});
