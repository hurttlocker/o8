import { describe, expect, it } from 'vitest';
import type { DockEntry } from './ui';
import {
  type CanvasConversationStore,
  MAX_CANVAS_CONVERSATION_ENTRIES,
  MAX_CANVAS_CONVERSATIONS,
  removeCanvasConversations,
  setCanvasConversation,
  updateCanvasConversation,
} from './canvas-conversation-retention';

function entry(id: number): DockEntry {
  return { id, role: 'text', text: `message ${id}` };
}

describe('Canvas conversation retention', () => {
  it('keeps only the newest entries in a live lane', () => {
    let store: CanvasConversationStore = {};
    for (let index = 0; index < 10_000; index += 1) {
      store = updateCanvasConversation(store, 'repo', (entries) => [...entries, entry(index)]);
    }
    expect(store.repo).toHaveLength(MAX_CANVAS_CONVERSATION_ENTRIES);
    expect(store.repo?.[0]?.id).toBe(10_000 - MAX_CANVAS_CONVERSATION_ENTRIES);
  });

  it('evicts inactive lanes and removes closed thread state', () => {
    let store: CanvasConversationStore = {};
    for (let index = 0; index < MAX_CANVAS_CONVERSATIONS + 8; index += 1) {
      store = setCanvasConversation(store, `thread:${index}`, [entry(index)]);
    }
    expect(Object.keys(store)).toHaveLength(MAX_CANVAS_CONVERSATIONS);
    expect(store['thread:0']).toBeUndefined();

    store = removeCanvasConversations(store, [`thread:${MAX_CANVAS_CONVERSATIONS + 7}`]);
    expect(store[`thread:${MAX_CANVAS_CONVERSATIONS + 7}`]).toBeUndefined();
  });
});
