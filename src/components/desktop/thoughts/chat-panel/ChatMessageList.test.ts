import { describe, expect, it } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { buildMissionRenderItems } from './ChatMessageList';

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
});
