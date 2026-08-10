// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { publishPersistedChatHistory } from './usePersistChatThread';

describe('publishPersistedChatHistory', () => {
  it('notifies the Chats rail after the durable thread write lands', () => {
    const listener = vi.fn();
    window.addEventListener('o8:chat-history-updated', listener);
    publishPersistedChatHistory('thoughts-new');
    window.removeEventListener('o8:chat-history-updated', listener);

    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ threadId: 'thoughts-new' });
  });
});
