// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_QUEUED_CONTEXT_CARDS_PER_DRAFT,
  MAX_WORKSPACE_CHAT_DRAFTS,
  readWorkspaceChatDraftState,
  resetWorkspaceChatDraftStatesForTests,
  useWorkspaceChatDraftRetention,
  writeWorkspaceChatDraftState,
} from './workspace-chat-drafts';

afterEach(resetWorkspaceChatDraftStatesForTests);

describe('workspace chat draft retention', () => {
  it('restores an unsent draft after its heavy tab surface is evicted', () => {
    writeWorkspaceChatDraftState('chat-1', {
      draft: 'keep this unsent thought',
      queuedContextCards: [{ id: 'context-1', text: 'issue context', title: 'Issue', meta: [] }],
    });

    expect(readWorkspaceChatDraftState('chat-1')).toEqual({
      draft: 'keep this unsent thought',
      queuedContextCards: [{ id: 'context-1', text: 'issue context', title: 'Issue', meta: [] }],
    });
  });

  it('restores through the real retention hook after unmount and remount', async () => {
    function Harness() {
      const retained = useWorkspaceChatDraftRetention('chat-hook');
      return createElement(
        'div',
        { 'data-draft': retained.draft, 'data-context-count': retained.queuedContextCards.length },
        createElement('button', {
          'data-set-draft': true,
          onClick: () => retained.setDraft('still here'),
        }),
        createElement('button', {
          'data-set-context': true,
          onClick: () => retained.setQueuedContextCards(Array.from(
            { length: MAX_QUEUED_CONTEXT_CARDS_PER_DRAFT + 3 },
            (_, index) => ({ id: `context-${index}`, text: 'context', title: 'Context', meta: [] }),
          )),
        }),
      );
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Harness)));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-set-draft]')?.click());
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(Harness)));
    expect(host.querySelector('[data-draft]')?.getAttribute('data-draft')).toBe('still here');
    await act(async () => host.querySelector<HTMLButtonElement>('[data-set-context]')?.click());
    expect(host.querySelector('[data-draft]')?.getAttribute('data-context-count'))
      .toBe(String(MAX_QUEUED_CONTEXT_CARDS_PER_DRAFT));
    await act(async () => root.unmount());
    host.remove();
  });

  it('bounds retained tabs and context cards', () => {
    for (let tab = 0; tab < MAX_WORKSPACE_CHAT_DRAFTS + 4; tab += 1) {
      writeWorkspaceChatDraftState(`chat-${tab}`, {
        draft: `draft-${tab}`,
        queuedContextCards: Array.from({ length: MAX_QUEUED_CONTEXT_CARDS_PER_DRAFT + 3 }, (_, card) => ({
          id: `context-${card}`,
          text: `context ${card}`,
          title: 'Context',
          meta: [],
        })),
      });
    }

    expect(readWorkspaceChatDraftState('chat-0').draft).toBe('');
    expect(readWorkspaceChatDraftState(`chat-${MAX_WORKSPACE_CHAT_DRAFTS + 3}`).queuedContextCards)
      .toHaveLength(MAX_QUEUED_CONTEXT_CARDS_PER_DRAFT);
  });

  it('drops the cache entry once the draft and context are consumed', () => {
    writeWorkspaceChatDraftState('chat-1', { draft: 'send me', queuedContextCards: [] });
    writeWorkspaceChatDraftState('chat-1', { draft: '', queuedContextCards: [] });
    expect(readWorkspaceChatDraftState('chat-1')).toEqual({ draft: '', queuedContextCards: [] });
  });
});
