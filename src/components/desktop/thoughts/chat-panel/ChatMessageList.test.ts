import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { deserializeStoredTranscript, serializeTranscriptForStorage } from '@/lib/transcripts/history-serde';
import { buildMissionRenderItems, ChatMessageList } from './ChatMessageList';
import type { QueuedComposerSendRecord } from '@/lib/orchestrator/composer-queue-types';

function entry(id: string, statusEvent?: MobileTranscriptEntry['statusEvent']): MobileTranscriptEntry {
  return {
    id,
    role: 'system',
    text: id,
    statusEvent,
  };
}

describe('buildMissionRenderItems', () => {
  it('renders a queued user message in the real transcript with a quiet delivery tag and live conversion action', () => {
    const item: QueuedComposerSendRecord = { id: 'queued-task', sequence: 1, repoPath: '/repo', threadId: 'thoughts-test', intent: 'send-next',
      status: 'queued', reason: null, createdAt: 1, updatedAt: 1, admittedAt: null, payload: { text: 'Use the smaller change', wireMessage: 'Use the smaller change', images: [],
        routing: { backend: 'pi', model: 'pi', effort: 'low', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false } } };
    const html = renderToStaticMarkup(createElement(ChatMessageList, {
      displayMessages: [{ id: 'working', role: 'assistant', text: 'Checking the change.' }], displayWaiting: true,
      activeTargetLabel: 'Agent', activeTargetColor: 'var(--t-accent)', thoughtsMutedGlass: 'transparent',
      thoughtsElevatedBorder: 'var(--t-divider)', thoughtsElevatedShadow: 'none', emptyStateFallback: null,
      composerQueue: { items: [item], canSteer: true, onSteer: () => {}, onCancel: () => {} },
    }));
    expect(html).toContain('Use the smaller change');
    expect(html).toContain('Queued');
    expect(html).toContain('Steer now');
  });
  it('retains an acknowledged steer tag after its recent queue receipt leaves the window', () => {
    const html = renderToStaticMarkup(createElement(ChatMessageList, {
      displayMessages: [{ id: 'composer-steer-older-receipt', role: 'user', text: 'Keep the smaller change.' }], displayWaiting: false,
      activeTargetLabel: 'Agent', activeTargetColor: 'var(--t-accent)', thoughtsMutedGlass: 'transparent',
      thoughtsElevatedBorder: 'var(--t-divider)', thoughtsElevatedShadow: 'none', emptyStateFallback: null,
      composerQueue: { items: [], canSteer: false, onSteer: () => {}, onCancel: () => {} },
    }));
    expect(html).toContain('Steer →');
    expect(html).not.toContain('Queued');
  });
  it('groups consecutive packet terminal status cards', () => {
    const items = buildMissionRenderItems([
      entry('merge-1', { kind: 'merge', packetTitle: 'One', branch: 'main' }),
      entry('merge-2', { kind: 'merge', packetTitle: 'Two', branch: 'main' }),
      entry('plain'),
    ]);

    expect(items[0]).toMatchObject({
      kind: 'mission-group',
      lastIndex: 1,
    });
    expect(items[0].kind === 'mission-group' ? items[0].entries.map((item) => item.id) : []).toEqual(['merge-1', 'merge-2']);
    expect(items[1]).toMatchObject({ kind: 'msg', index: 2 });
  });

  it('keeps a single terminal status card ungrouped', () => {
    const items = buildMissionRenderItems([
      entry('merge-1', { kind: 'merge', packetTitle: 'One', branch: 'main' }),
      entry('plain'),
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'msg', index: 0 });
  });

  it('renders a receipt-only summary from reloaded transcript state', () => {
    const displayMessages = deserializeStoredTranscript(serializeTranscriptForStorage([{
      id: 'assistant-reloaded',
      role: 'assistant',
      text: 'Complete.',
      receipt: { leadModel: 'gpt-6-astra', effort: 'high', mode: 'multitask' },
    }]));
    const html = renderToStaticMarkup(createElement(ChatMessageList, {
      displayMessages,
      displayWaiting: false,
      activeTargetLabel: 'Lead',
      activeTargetColor: 'var(--t-accent)',
      thoughtsMutedGlass: 'var(--t-surface-muted)',
      thoughtsElevatedBorder: 'var(--t-divider)',
      thoughtsElevatedShadow: 'none',
      emptyStateFallback: null,
    }));

    expect(html).toContain('GPT-6 Astra · high · Worktrees');
  });
});
