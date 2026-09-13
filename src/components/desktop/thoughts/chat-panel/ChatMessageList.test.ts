import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { deserializeStoredTranscript, serializeTranscriptForStorage } from '@/lib/transcripts/history-serde';
import { buildMissionRenderItems, ChatMessageList } from './ChatMessageList';

function entry(id: string, statusEvent?: MobileTranscriptEntry['statusEvent']): MobileTranscriptEntry {
  return {
    id,
    role: 'system',
    text: id,
    statusEvent,
  };
}

describe('buildMissionRenderItems', () => {
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

    expect(html).toContain('GPT-6 Astra · high · Multitask');
  });
});
